import { isEmpty, isNumber, isObjectLike, isString } from 'lodash-es';

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

function toLowerText(value: string | undefined): string {
  return (value ?? '').toLowerCase();
}

function parseDurationToSeconds(text: string): number | null {
  const match = text.match(/(?:(\d+)h)?(?:(\d+)m)?(?:(\d+(?:\.\d+)?)s)?(?:(\d+(?:\.\d+)?)ms)?/i);
  if (!match) {
    return null;
  }

  const hours = Number(match[1] ?? 0);
  const minutes = Number(match[2] ?? 0);
  const seconds = Number(match[3] ?? 0);
  const milliseconds = Number(match[4] ?? 0);

  const totalSeconds =
    hours * 3600 + minutes * 60 + Math.ceil(seconds) + Math.ceil(milliseconds / 1000);
  if (totalSeconds <= 0) {
    return null;
  }
  return totalSeconds;
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
    const retryAfterSec = Math.max(2, Math.ceil((resetTimeMs - Date.now()) / 1000));
    const key = !isEmpty(model?.trim() ?? '') ? this.buildLockoutKey(accountId, model) : accountId;
    this.lockoutByKey.set(key, {
      resetTimeMs,
      retryAfterSec,
      reason,
      model,
    });
  }

  clear(accountId: string): boolean {
    return this.lockoutByKey.delete(accountId);
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
    const retryAfterSec = this.computeRetryAfterSeconds({
      reason,
      status,
      retryAfter: params.retryAfter,
      body: params.body,
      accountId: params.accountId,
      backoffSteps: params.backoffSteps,
    });

    const info: RateLimitInfo = {
      reason,
      retryAfterSec,
      resetTimeMs: Date.now() + retryAfterSec * 1000,
      model: params.model,
    };

    const useModelKey = reason === RateLimitReason.QuotaExhausted && Boolean(params.model);
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
    if (statusFromBody === 'RESOURCE_EXHAUSTED') {
      return RateLimitReason.QuotaExhausted;
    }
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
    if (
      lowerBody.includes('per minute') ||
      lowerBody.includes('rate limit') ||
      lowerBody.includes('rate_limit') ||
      lowerBody.includes('too many requests')
    ) {
      return RateLimitReason.RateLimitExceeded;
    }
    if (
      lowerBody.includes('model capacity exhausted') ||
      lowerBody.includes('no capacity available')
    ) {
      return RateLimitReason.ModelCapacityExhausted;
    }
    if (lowerBody.includes('quota') || lowerBody.includes('exhausted')) {
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
      return 5;
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
    const parsedBody = tryParseGoogleErrorBody(body);
    const details = Array.isArray(parsedBody?.error?.details) ? parsedBody.error.details : [];
    for (const detail of details) {
      if (isString(detail.retryDelay) && !isEmpty(detail.retryDelay.trim())) {
        const parsedDelay = parseDurationToSeconds(detail.retryDelay);
        if (parsedDelay !== null) {
          return parsedDelay;
        }
      }

      if (
        isString(detail.metadata?.retryDelay) &&
        !isEmpty(detail.metadata.retryDelay.trim())
      ) {
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
