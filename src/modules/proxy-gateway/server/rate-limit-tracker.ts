import { isEmpty, isNumber, isObjectLike, isString } from 'lodash-es';
import { getQuotaModelFamilyId } from '@/modules/cloud-account/utils/quota-model-families';

export enum RateLimitReason {
  QuotaExhausted = 'quota_exhausted',
  RateLimitExceeded = 'rate_limit_exceeded',
  ModelCapacityExhausted = 'model_capacity_exhausted',
  ServerError = 'server_error',
  Unknown = 'unknown',
}

interface RateLimitInfo {
  resetTimeMs: number;
  retryAfterSec: number;
  reason: RateLimitReason;
  model?: string;
}

type FailureCountEntry = {
  count: number;
  lastFailureMs: number;
};

interface GoogleErrorDetail {
  reason?: string;
  retryDelay?: string;
  metadata?: {
    quotaResetDelay?: string;
    retryDelay?: string;
  };
}

interface ParsedGoogleErrorBody {
  error?: {
    status?: string;
    details?: GoogleErrorDetail[];
    retry_after?: number;
  };
}

const FAILURE_COUNT_EXPIRY_MS = 60 * 60 * 1000;
const MAX_RETRY_DELAY_SEARCH_DEPTH = 8;
const MAX_LOCKOUT_SECONDS = 300;
const GRACE_RETRY_WINDOW_MS = 2000;
export const GRACE_RETRY_BUFFER_MS = 1500;
const DURATION_UNIT_TO_MS = {
  ms: 1,
  s: 1000,
  m: 60 * 1000,
  h: 60 * 60 * 1000,
} as const;
const RETRY_HINT_KEYS = new Set(['retryafter', 'retrydelay', 'quotaresetdelay', 'backofflimit']);
const QUOTA_RETRY_PATTERNS = [
  /quota will reset after ([^.,;\]\n]+)/i,
  /retry after ([^.,;\]\n]+)/i,
  /quotaResetDelay["'=:\s]+([^\s,"}\]]+)/i,
];

function toLowerText(value: string | undefined): string {
  return (value ?? '').toLowerCase();
}

export function hasGenericResourceExhaustedSignal(body: string | undefined): boolean {
  const lowerBody = toLowerText(body);
  return (
    lowerBody.includes('resource has been exhausted') || lowerBody.includes('resource_exhausted')
  );
}

export function hasExplicitQuotaExhaustedSignal(body: string | undefined): boolean {
  const lowerBody = toLowerText(body);
  return (
    lowerBody.includes('quota_exhausted') ||
    lowerBody.includes('quota exceeded') ||
    lowerBody.includes('quotaresetdelay') ||
    lowerBody.includes('quota reset') ||
    lowerBody.includes('quota limit') ||
    lowerBody.includes('quota will reset') ||
    lowerBody.includes('per day') ||
    lowerBody.includes('daily quota')
  );
}

function parseDurationToMilliseconds(text: string): number | null {
  const durationRegex = /([\d.]+)\s*(ms|s|m|h)/gi;
  let totalMs = 0;
  let matched = false;

  for (const match of text.matchAll(durationRegex)) {
    matched = true;
    const value = Number(match[1]);
    if (!Number.isFinite(value)) {
      return null;
    }

    const unit = match[2].toLowerCase() as keyof typeof DURATION_UNIT_TO_MS;
    totalMs += value * DURATION_UNIT_TO_MS[unit];
  }

  if (!matched) {
    return null;
  }

  return Math.round(totalMs);
}

function parseDurationToSeconds(text: string): number | null {
  const milliseconds = parseDurationToMilliseconds(text);
  if (milliseconds === null || milliseconds <= 0) {
    return null;
  }
  return Math.ceil(milliseconds / 1000);
}

function tryParseGoogleErrorBody(body: string | undefined): ParsedGoogleErrorBody | null {
  const trimmed = (body ?? '').trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
    return null;
  }

  try {
    const parsed = JSON.parse(trimmed) as ParsedGoogleErrorBody;
    if (!isObjectLike(parsed)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function mapGoogleReasonToTrackerReason(reason: string): RateLimitReason | null {
  const normalizedReason = reason.trim().toUpperCase();
  if (normalizedReason === 'QUOTA_EXHAUSTED') {
    return RateLimitReason.QuotaExhausted;
  }
  if (normalizedReason === 'RATE_LIMIT_EXCEEDED') {
    return RateLimitReason.RateLimitExceeded;
  }
  if (normalizedReason === 'MODEL_CAPACITY_EXHAUSTED') {
    return RateLimitReason.ModelCapacityExhausted;
  }
  return null;
}

function normalizeRetryHintKey(key: string): string {
  return key.toLowerCase().replace(/[-_]/g, '');
}

function parseStructuredDurationObject(value: unknown): number | null {
  if (!isObjectLike(value)) {
    return null;
  }

  const obj = value as Record<string, unknown>;
  const seconds = Number(obj.seconds ?? obj.Seconds ?? 0);
  const nanos = Number(obj.nanos ?? obj.Nanos ?? 0);

  if ((!Number.isFinite(seconds) || seconds <= 0) && (!Number.isFinite(nanos) || nanos <= 0)) {
    return null;
  }

  return Math.round(Math.max(0, seconds) * 1000 + Math.max(0, nanos) / 1_000_000);
}

function parseStructuredDurationValue(value: unknown): number | null {
  if (isString(value)) {
    return parseDurationToMilliseconds(value);
  }

  if (isNumber(value) && value > 0) {
    return Math.round(value * 1000);
  }

  return parseStructuredDurationObject(value);
}

function extractStructuredDelayRecursive(value: unknown, depth: number): number | null {
  if (depth > MAX_RETRY_DELAY_SEARCH_DEPTH) {
    return null;
  }

  if (isString(value)) {
    return parseDurationToMilliseconds(value);
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const delay = extractStructuredDelayRecursive(item, depth + 1);
      if (delay !== null) {
        return delay;
      }
    }
    return null;
  }

  if (!isObjectLike(value)) {
    return null;
  }

  const durationObjectDelay = parseStructuredDurationObject(value);
  if (durationObjectDelay !== null) {
    return durationObjectDelay;
  }

  for (const [key, childValue] of Object.entries(value as Record<string, unknown>)) {
    if (RETRY_HINT_KEYS.has(normalizeRetryHintKey(key))) {
      const hintedDelay = parseStructuredDurationValue(childValue);
      if (hintedDelay !== null) {
        return hintedDelay;
      }
    }

    const nestedDelay = extractStructuredDelayRecursive(childValue, depth + 1);
    if (nestedDelay !== null) {
      return nestedDelay;
    }
  }

  return null;
}

export function parseRetryDelayMilliseconds(errorText: string | undefined): number | null {
  if (!errorText) {
    return null;
  }

  for (const pattern of QUOTA_RETRY_PATTERNS) {
    const match = errorText.match(pattern);
    if (match?.[1]) {
      const delay = parseDurationToMilliseconds(match[1]);
      if (delay !== null) {
        return delay;
      }
    }
  }

  const parsedBody = tryParseGoogleErrorBody(errorText);
  const delay = parsedBody ? extractStructuredDelayRecursive(parsedBody, 0) : null;
  return delay;
}

export function shouldGraceRetry(delayMs: number): boolean {
  return delayMs > 0 && delayMs <= GRACE_RETRY_WINDOW_MS;
}

export class RateLimitTracker {
  private readonly lockoutByKey = new Map<string, RateLimitInfo>();
  private readonly failureCounts = new Map<string, FailureCountEntry>();

  private buildLockoutKey(accountId: string, model?: string): string {
    if (!isEmpty(model?.trim() ?? '')) {
      return `${accountId}:${model}`;
    }
    return accountId;
  }

  getRemainingWaitSeconds(accountId: string, model?: string): number {
    const now = Date.now();

    const globalLock = this.lockoutByKey.get(accountId);
    if (globalLock && globalLock.resetTimeMs > now) {
      return Math.max(0, Math.ceil((globalLock.resetTimeMs - now) / 1000));
    }

    if (model) {
      const modelKey = this.buildLockoutKey(accountId, model);
      const modelLock = this.lockoutByKey.get(modelKey);
      if (modelLock && modelLock.resetTimeMs > now) {
        return Math.max(0, Math.ceil((modelLock.resetTimeMs - now) / 1000));
      }
    }

    return 0;
  }

  getRemainingWaitSec(accountId: string, model?: string): number {
    return this.getRemainingWaitSeconds(accountId, model);
  }

  isRateLimited(accountId: string, model?: string): boolean {
    return this.getRemainingWaitSeconds(accountId, model) > 0;
  }

  setLockoutUntilIso(
    accountId: string,
    resetTimeIso: string,
    reason: RateLimitReason,
    model?: string,
  ): boolean {
    const timestamp = Date.parse(resetTimeIso);
    if (!Number.isFinite(timestamp)) {
      return false;
    }
    this.setLockoutUntil(accountId, timestamp, reason, model);
    return true;
  }

  private setLockoutUntil(
    accountId: string,
    resetTimeMs: number,
    reason: RateLimitReason,
    model?: string,
  ): void {
    const now = Date.now();
    const retryAfterSec = Math.min(
      MAX_LOCKOUT_SECONDS,
      Math.max(2, Math.ceil((resetTimeMs - now) / 1000)),
    );
    const key = !isEmpty(model?.trim() ?? '') ? this.buildLockoutKey(accountId, model) : accountId;
    this.lockoutByKey.set(key, {
      resetTimeMs: now + retryAfterSec * 1000,
      retryAfterSec,
      reason,
      model,
    });
  }

  clear(accountId: string): boolean {
    return this.lockoutByKey.delete(accountId);
  }

  clearModel(accountId: string, model: string): boolean {
    return this.lockoutByKey.delete(this.buildLockoutKey(accountId, model));
  }

  /**
   * Quota responses use canonical model ids while request failures can be keyed by a routed alias.
   * Compare known routing families so a recovered canonical model also releases its alias lock.
   */
  clearModelFamilies(accountId: string, models: Iterable<string>): number {
    const recoveredFamilies = new Set(Array.from(models, (model) => getQuotaModelFamilyId(model)));
    if (recoveredFamilies.size === 0) {
      return 0;
    }

    let deleted = 0;
    for (const [key, info] of this.lockoutByKey.entries()) {
      if (!info.model || key !== this.buildLockoutKey(accountId, info.model)) {
        continue;
      }

      if (recoveredFamilies.has(getQuotaModelFamilyId(info.model))) {
        this.lockoutByKey.delete(key);
        deleted += 1;
      }
    }

    return deleted;
  }

  clearAll(): number {
    const size = this.lockoutByKey.size;
    this.lockoutByKey.clear();
    return size;
  }

  cleanupExpired(): number {
    const now = Date.now();
    let deleted = 0;
    for (const [key, info] of this.lockoutByKey.entries()) {
      if (info.resetTimeMs <= now) {
        this.lockoutByKey.delete(key);
        deleted++;
      }
    }
    return deleted;
  }

  markSuccess(accountId: string): void {
    this.failureCounts.delete(accountId);
    this.lockoutByKey.delete(accountId);
  }

  markModelSuccess(accountId: string, model: string): void {
    this.failureCounts.delete(accountId);
    this.clearModel(accountId, model);
  }

  trackFromUpstreamError(params: {
    accountId: string;
    status?: number;
    retryAfter?: string;
    body?: string;
    model?: string;
    backoffSteps: number[];
  }): RateLimitInfo | null {
    const status = params.status ?? 0;
    if (![404, 429, 500, 503, 529].includes(status)) {
      return null;
    }

    const reason = this.detectRateLimitReason(status, params.body);
    const retryAfterSec = Math.min(
      MAX_LOCKOUT_SECONDS,
      this.computeRetryAfterSeconds({
        reason,
        status,
        retryAfter: params.retryAfter,
        body: params.body,
        accountId: params.accountId,
        backoffSteps: params.backoffSteps,
      }),
    );

    const info: RateLimitInfo = {
      reason,
      retryAfterSec,
      resetTimeMs: Date.now() + retryAfterSec * 1000,
      model: params.model,
    };

    const useModelKey =
      Boolean(params.model) &&
      (reason === RateLimitReason.QuotaExhausted ||
        reason === RateLimitReason.RateLimitExceeded ||
        reason === RateLimitReason.ModelCapacityExhausted);
    const key = useModelKey
      ? this.buildLockoutKey(params.accountId, params.model)
      : params.accountId;
    this.lockoutByKey.set(key, info);

    return info;
  }

  parseAndMarkFromError(params: {
    accountId: string;
    status?: number;
    retryAfter?: string;
    body?: string;
    model?: string;
    backoffSteps: number[];
  }): RateLimitInfo | null {
    return this.trackFromUpstreamError(params);
  }

  private detectRateLimitReason(status: number, body: string | undefined): RateLimitReason {
    const parsedBody = tryParseGoogleErrorBody(body);
    const details = Array.isArray(parsedBody?.error?.details) ? parsedBody?.error?.details : [];
    for (const detail of details) {
      if (!isString(detail.reason) || isEmpty(detail.reason.trim())) {
        continue;
      }
      const mappedReason = mapGoogleReasonToTrackerReason(detail.reason);
      if (mappedReason) {
        return mappedReason;
      }
    }

    const statusFromBody = parsedBody?.error?.status?.trim().toUpperCase();
    if (statusFromBody === 'UNAVAILABLE') {
      const loweredBody = toLowerText(body);
      if (loweredBody.includes('no capacity available') || loweredBody.includes('model capacity')) {
        return RateLimitReason.ModelCapacityExhausted;
      }
    }

    if (status !== 429) {
      return RateLimitReason.ServerError;
    }

    const lowerBody = toLowerText(body);
    const hasGenericResourceExhausted =
      statusFromBody === 'RESOURCE_EXHAUSTED' || hasGenericResourceExhaustedSignal(body);
    const hasExplicitQuotaExhausted = hasExplicitQuotaExhaustedSignal(body);
    if (
      lowerBody.includes('per minute') ||
      lowerBody.includes('rate limit') ||
      lowerBody.includes('rate_limit') ||
      lowerBody.includes('too many requests') ||
      (hasGenericResourceExhausted && !hasExplicitQuotaExhausted)
    ) {
      return RateLimitReason.RateLimitExceeded;
    }
    if (
      lowerBody.includes('model capacity exhausted') ||
      lowerBody.includes('no capacity available')
    ) {
      return RateLimitReason.ModelCapacityExhausted;
    }
    if (hasExplicitQuotaExhausted || lowerBody.includes('quota')) {
      return RateLimitReason.QuotaExhausted;
    }

    return RateLimitReason.Unknown;
  }

  private computeRetryAfterSeconds(params: {
    reason: RateLimitReason;
    status: number;
    retryAfter?: string;
    body?: string;
    accountId: string;
    backoffSteps: number[];
  }): number {
    const headerRetryRaw = params.retryAfter?.trim() ?? '';
    if (headerRetryRaw !== '') {
      const headerRetry = Number(headerRetryRaw);
      if (!Number.isNaN(headerRetry) && Number.isFinite(headerRetry) && headerRetry > 0) {
        return Math.max(2, Math.ceil(headerRetry));
      }

      const headerRetryAt = Date.parse(headerRetryRaw);
      if (Number.isFinite(headerRetryAt)) {
        const retryAfterSec = Math.ceil((headerRetryAt - Date.now()) / 1000);
        if (retryAfterSec > 0) {
          return Math.max(2, retryAfterSec);
        }
      }
    }

    const bodyRetry = this.parseRetryAfterSecondsFromBody(params.body);
    if (bodyRetry !== null) {
      return Math.max(2, Math.ceil(bodyRetry));
    }

    const failureCount =
      params.reason !== RateLimitReason.ServerError
        ? this.incrementFailureCount(params.accountId)
        : 1;

    if (params.reason === RateLimitReason.QuotaExhausted) {
      const steps = params.backoffSteps.length > 0 ? params.backoffSteps : [60, 300, 1800, 7200];
      const index = Math.max(0, failureCount - 1);
      return steps[Math.min(index, steps.length - 1)];
    }

    if (params.reason === RateLimitReason.RateLimitExceeded) {
      return hasGenericResourceExhaustedSignal(params.body) ? 30 : 5;
    }

    if (params.reason === RateLimitReason.ModelCapacityExhausted) {
      if (failureCount <= 1) {
        return 5;
      }
      if (failureCount === 2) {
        return 10;
      }
      return 15;
    }

    if (params.reason === RateLimitReason.ServerError) {
      return params.status === 404 ? 5 : 8;
    }

    return 60;
  }

  private parseRetryAfterSecondsFromBody(body: string | undefined): number | null {
    if (!body) {
      return null;
    }
    const deepParsedRetry = parseRetryDelayMilliseconds(body);
    if (deepParsedRetry !== null) {
      return Math.ceil((deepParsedRetry + GRACE_RETRY_BUFFER_MS) / 1000);
    }

    const parsedBody = tryParseGoogleErrorBody(body);
    const details = Array.isArray(parsedBody?.error?.details) ? parsedBody.error.details : [];
    for (const detail of details) {
      if (isString(detail.retryDelay) && !isEmpty(detail.retryDelay.trim())) {
        const parsedDelay = parseDurationToSeconds(detail.retryDelay);
        if (parsedDelay !== null) {
          return parsedDelay;
        }
      }

      if (isString(detail.metadata?.retryDelay) && !isEmpty(detail.metadata.retryDelay.trim())) {
        const parsedDelay = parseDurationToSeconds(detail.metadata.retryDelay);
        if (parsedDelay !== null) {
          return parsedDelay;
        }
      }

      if (
        isString(detail.metadata?.quotaResetDelay) &&
        !isEmpty(detail.metadata.quotaResetDelay.trim())
      ) {
        const parsedDelay = parseDurationToSeconds(detail.metadata.quotaResetDelay);
        if (parsedDelay !== null) {
          return parsedDelay;
        }
      }
    }

    const retryAfter = parsedBody?.error?.retry_after;
    if (isNumber(retryAfter) && retryAfter > 0) {
      return Math.ceil(retryAfter);
    }

    const lowerBody = toLowerText(body);
    const minSecMatch = lowerBody.match(/try again in\s+(\d+)m\s*(\d+)s/);
    if (minSecMatch) {
      return Number(minSecMatch[1]) * 60 + Number(minSecMatch[2]);
    }

    const secMatch = lowerBody.match(/(?:try again in|backoff for|wait)\s*(\d+)s/);
    if (secMatch) {
      return Number(secMatch[1]);
    }

    const resetMatch = lowerBody.match(/quota will reset in\s*(\d+)\s*second/);
    if (resetMatch) {
      return Number(resetMatch[1]);
    }

    return null;
  }

  private incrementFailureCount(accountId: string): number {
    const now = Date.now();
    const entry = this.failureCounts.get(accountId);
    if (!entry) {
      this.failureCounts.set(accountId, { count: 1, lastFailureMs: now });
      return 1;
    }

    if (now - entry.lastFailureMs > FAILURE_COUNT_EXPIRY_MS) {
      this.failureCounts.set(accountId, { count: 1, lastFailureMs: now });
      return 1;
    }

    const nextCount = entry.count + 1;
    this.failureCounts.set(accountId, { count: nextCount, lastFailureMs: now });
    return nextCount;
  }
}
