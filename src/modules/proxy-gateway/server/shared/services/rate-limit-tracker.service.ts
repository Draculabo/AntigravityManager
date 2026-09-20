import { Injectable } from '@nestjs/common';
import { isEmpty, isNumber, isString } from 'lodash-es';
import { z } from 'zod';
import { getQuotaModelFamilyId } from '@/modules/cloud-account/utils/quota-model-families';
import { normalizeGeminiModelAlias } from '@/modules/proxy-gateway/antigravity/ModelMapping';

export enum RateLimitReason {
  QuotaExhausted = 'quota_exhausted',
  RateLimitExceeded = 'rate_limit_exceeded',
  ModelCapacityExhausted = 'model_capacity_exhausted',
  ServerError = 'server_error',
  Unknown = 'unknown',
}

export interface RateLimitInfo {
  resetTimeMs: number;
  retryAfterSec: number;
  reason: RateLimitReason;
  model?: string;
  preservesLongImageQuota: boolean;
}

export type RetryDelaySource = 'retry-after' | 'structured' | 'text';

export interface ParsedRetryDelay {
  delayMs: number;
  source: RetryDelaySource;
}

export interface PersistedModelRateLimit {
  accountId: string;
  modelId: string;
  reason: string;
  unavailableUntil: number;
  detectedAt: number;
  status?: number;
  message?: string;
}

type FailureCountEntry = {
  count: number;
  lastFailureMs: number;
};

const GoogleErrorMetadataSchema = z.object({
  quotaResetDelay: z.string().optional().catch(undefined),
  retryDelay: z.string().optional().catch(undefined),
});

const GoogleErrorDetailSchema = z.object({
  reason: z.string().optional().catch(undefined),
  retryDelay: z.string().optional().catch(undefined),
  metadata: GoogleErrorMetadataSchema.optional().catch(undefined),
});

const GoogleErrorEnvelopeSchema = z
  .object({
    status: z.string().optional(),
    details: z.array(z.unknown()).optional(),
    retry_after: z.number().optional(),
  })
  .passthrough();

const GoogleErrorBodySchema = z
  .object({
    error: GoogleErrorEnvelopeSchema.optional(),
  })
  .passthrough();

const ParsedGoogleErrorBodySchema = z.union([GoogleErrorBodySchema, z.array(z.unknown())]);

type GoogleErrorDetail = z.infer<typeof GoogleErrorDetailSchema>;
type GoogleErrorEnvelope = z.infer<typeof GoogleErrorEnvelopeSchema>;
type ParsedGoogleErrorBody = z.infer<typeof ParsedGoogleErrorBodySchema>;

const FAILURE_COUNT_EXPIRY_MS = 60 * 60 * 1000;
const MAX_RETRY_DELAY_SEARCH_DEPTH = 8;
const MAX_LOCKOUT_SECONDS = 300;
const GRACE_RETRY_WINDOW_MS = 5000;
export const STRUCTURED_GRACE_RETRY_BUFFER_MS = 200;
export const TEXT_GRACE_RETRY_BUFFER_MS = 1000;
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

type DurationUnit = keyof typeof DURATION_UNIT_TO_MS;

function toLowerText(value: string | undefined): string {
  return (value ?? '').toLowerCase();
}

function isDurationUnit(value: string): value is DurationUnit {
  return value === 'ms' || value === 's' || value === 'm' || value === 'h';
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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

function hasDurableQuotaExhaustedSignal(body: string | undefined): boolean {
  const lowerBody = toLowerText(body);
  return (
    lowerBody.includes('quota exceeded') ||
    lowerBody.includes('quotaresetdelay') ||
    lowerBody.includes('quota reset') ||
    lowerBody.includes('quota limit') ||
    lowerBody.includes('quota will reset') ||
    lowerBody.includes('per day') ||
    lowerBody.includes('daily quota')
  );
}

export function hasStrictQuotaExhaustedMarker(body: string | undefined): boolean {
  return toLowerText(body).includes('quota_exhausted');
}

export function isGeminiImageModel(model: string | undefined): boolean {
  if (!model) {
    return false;
  }
  const family = getQuotaModelFamilyId(model);
  return family === 'gemini-pro-image' || family === 'gemini-flash-image';
}

const LONG_IMAGE_QUOTA_MODELS = new Set([
  'gemini-3-pro-image',
  'gemini-3.1-pro-image',
  'gemini-3.1-flash-image',
]);

export function isRecognizedGeminiImageModel(model: string | undefined): boolean {
  if (!model) {
    return false;
  }
  const normalized = normalizeGeminiModelAlias(
    model.trim().replace(/^models\//i, ''),
  ).toLowerCase();
  return LONG_IMAGE_QUOTA_MODELS.has(normalized);
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

    const unit = match[2]?.toLowerCase();
    if (!unit || !isDurationUnit(unit)) {
      return null;
    }
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
    const rawBody: unknown = JSON.parse(trimmed);
    const parsedBody = ParsedGoogleErrorBodySchema.safeParse(rawBody);
    return parsedBody.success ? parsedBody.data : null;
  } catch {
    return null;
  }
}

function getGoogleErrorEnvelope(
  parsedBody: ParsedGoogleErrorBody | null,
): GoogleErrorEnvelope | undefined {
  return parsedBody && !Array.isArray(parsedBody) ? parsedBody.error : undefined;
}

function getGoogleErrorDetails(error: GoogleErrorEnvelope | undefined): GoogleErrorDetail[] {
  return (error?.details ?? []).flatMap((detail) => {
    const parsedDetail = GoogleErrorDetailSchema.safeParse(detail);
    return parsedDetail.success ? [parsedDetail.data] : [];
  });
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
  if (!isUnknownRecord(value)) {
    return null;
  }

  const seconds = Number(value.seconds ?? value.Seconds ?? 0);
  const nanos = Number(value.nanos ?? value.Nanos ?? 0);

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
    return null;
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

  if (!isUnknownRecord(value)) {
    return null;
  }

  for (const [key, childValue] of Object.entries(value)) {
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

function extractBaselineStructuredDelayRecursive(value: unknown, depth: number): number | null {
  if (depth > MAX_RETRY_DELAY_SEARCH_DEPTH) {
    return null;
  }
  if (isString(value)) {
    return parseDurationToMilliseconds(value);
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const delay = extractBaselineStructuredDelayRecursive(item, depth + 1);
      if (delay !== null) {
        return delay;
      }
    }
    return null;
  }
  if (!isUnknownRecord(value)) {
    return null;
  }
  const durationObjectDelay = parseStructuredDurationObject(value);
  if (durationObjectDelay !== null) {
    return durationObjectDelay;
  }
  for (const childValue of Object.values(value)) {
    const delay = extractBaselineStructuredDelayRecursive(childValue, depth + 1);
    if (delay !== null) {
      return delay;
    }
  }
  return null;
}

function parseRetryAfterHeaderMilliseconds(retryAfter: string | undefined): number | null {
  const rawValue = retryAfter?.trim() ?? '';
  if (rawValue === '') {
    return null;
  }

  const seconds = Number(rawValue);
  if (Number.isFinite(seconds) && seconds > 0) {
    return Math.round(seconds * 1000);
  }

  const deadline = Date.parse(rawValue);
  if (!Number.isFinite(deadline)) {
    return null;
  }
  return Math.max(0, deadline - Date.now());
}

export function parseRetryDelay(
  errorText: string | undefined,
  retryAfter?: string,
): ParsedRetryDelay | null {
  const headerDelay = parseRetryAfterHeaderMilliseconds(retryAfter);
  if (headerDelay !== null && headerDelay > 0) {
    return { delayMs: headerDelay, source: 'retry-after' };
  }

  if (!errorText) {
    return null;
  }

  const parsedBody = tryParseGoogleErrorBody(errorText);
  const structuredDelay = parsedBody ? extractStructuredDelayRecursive(parsedBody, 0) : null;
  if (structuredDelay !== null) {
    return { delayMs: structuredDelay, source: 'structured' };
  }

  for (const pattern of QUOTA_RETRY_PATTERNS) {
    const match = errorText.match(pattern);
    if (match?.[1]) {
      const delay = parseDurationToMilliseconds(match[1]);
      if (delay !== null) {
        return { delayMs: delay, source: 'text' };
      }
    }
  }

  return null;
}

export function parseRetryDelayMilliseconds(errorText: string | undefined): number | null {
  return parseRetryDelay(errorText)?.delayMs ?? null;
}

export function parseBaselineRetryDelayMilliseconds(errorText: string | undefined): number | null {
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
  return parsedBody ? extractBaselineStructuredDelayRecursive(parsedBody, 0) : null;
}

export function shouldGraceRetry(delayMs: number): boolean {
  return delayMs > 0 && delayMs <= GRACE_RETRY_WINDOW_MS;
}

@Injectable()
export class RateLimitTrackerService {
  private readonly lockoutByKey = new Map<string, RateLimitInfo>();
  private readonly failureCounts = new Map<string, FailureCountEntry>();

  private buildLockoutKey(accountId: string, model?: string): string {
    if (!isEmpty(model?.trim() ?? '')) {
      const lockoutModel = isGeminiImageModel(model) ? getQuotaModelFamilyId(model ?? '') : model;
      return `${accountId}:${lockoutModel}`;
    }
    return accountId;
  }

  private buildFailureCountKey(accountId: string, reason: RateLimitReason, model?: string): string {
    const isModelScoped =
      !isEmpty(model?.trim() ?? '') &&
      (reason === RateLimitReason.QuotaExhausted ||
        reason === RateLimitReason.RateLimitExceeded ||
        reason === RateLimitReason.ModelCapacityExhausted);
    return isModelScoped ? this.buildLockoutKey(accountId, model) : accountId;
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
    preservesLongImageQuota = false,
  ): void {
    const now = Date.now();
    const rawRetryAfterSec = Math.max(2, Math.ceil((resetTimeMs - now) / 1000));
    const retryAfterSec = preservesLongImageQuota
      ? rawRetryAfterSec
      : Math.min(MAX_LOCKOUT_SECONDS, rawRetryAfterSec);
    const key = !isEmpty(model?.trim() ?? '') ? this.buildLockoutKey(accountId, model) : accountId;
    this.lockoutByKey.set(key, {
      resetTimeMs: now + retryAfterSec * 1000,
      retryAfterSec,
      reason,
      model,
      preservesLongImageQuota,
    });
  }

  restorePersistedLongImageLimit(entry: PersistedModelRateLimit): boolean {
    const now = Date.now();
    if (
      entry.status !== 429 ||
      entry.reason !== 'quota_exhausted' ||
      !isRecognizedGeminiImageModel(entry.modelId) ||
      !hasStrictQuotaExhaustedMarker(entry.message) ||
      entry.unavailableUntil <= now ||
      entry.unavailableUntil - entry.detectedAt <= MAX_LOCKOUT_SECONDS * 1000 ||
      (parseRetryDelayMilliseconds(entry.message) ?? 0) <= MAX_LOCKOUT_SECONDS * 1000
    ) {
      return false;
    }

    this.setLockoutUntil(
      entry.accountId,
      entry.unavailableUntil,
      RateLimitReason.QuotaExhausted,
      entry.modelId,
      true,
    );
    return true;
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

      if (
        recoveredFamilies.has(getQuotaModelFamilyId(info.model)) &&
        !(info.preservesLongImageQuota && info.resetTimeMs > Date.now())
      ) {
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
    this.failureCounts.delete(this.buildLockoutKey(accountId, model));
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

    const reason = this.detectRateLimitReason(status, params.body, params.retryAfter);
    const rawRetryAfterSec = this.computeRetryAfterSeconds({
      reason,
      status,
      retryAfter: params.retryAfter,
      body: params.body,
      accountId: params.accountId,
      model: params.model,
      backoffSteps: params.backoffSteps,
    });
    const rawResetTimeMs = Date.now() + rawRetryAfterSec * 1000;
    const preservesLongImageQuota = this.isQualifiedLongImageQuota({
      status,
      reason,
      model: params.model,
      body: params.body,
      retryAfter: params.retryAfter,
      resetTimeMs: rawResetTimeMs,
      now: Date.now(),
    });
    const retryAfterSec = preservesLongImageQuota
      ? rawRetryAfterSec
      : Math.min(MAX_LOCKOUT_SECONDS, rawRetryAfterSec);

    const info: RateLimitInfo = {
      reason,
      retryAfterSec,
      resetTimeMs: Date.now() + retryAfterSec * 1000,
      model: params.model,
      preservesLongImageQuota,
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

  private isQualifiedLongImageQuota(params: {
    status?: number;
    reason: RateLimitReason;
    model?: string;
    body?: string;
    retryAfter?: string;
    resetTimeMs: number;
    now: number;
  }): boolean {
    if (
      params.status !== 429 ||
      params.reason !== RateLimitReason.QuotaExhausted ||
      !isRecognizedGeminiImageModel(params.model) ||
      !hasStrictQuotaExhaustedMarker(params.body) ||
      params.resetTimeMs - params.now <= MAX_LOCKOUT_SECONDS * 1000
    ) {
      return false;
    }

    const explicitDelay = parseRetryDelay(params.body, params.retryAfter);
    return explicitDelay !== null && explicitDelay.delayMs > MAX_LOCKOUT_SECONDS * 1000;
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

  private detectRateLimitReason(
    status: number,
    body: string | undefined,
    retryAfter?: string,
  ): RateLimitReason {
    const parsedBody = tryParseGoogleErrorBody(body);
    const error = getGoogleErrorEnvelope(parsedBody);
    const details = getGoogleErrorDetails(error);
    for (const detail of details) {
      if (!isString(detail.reason) || isEmpty(detail.reason.trim())) {
        continue;
      }
      const mappedReason = mapGoogleReasonToTrackerReason(detail.reason);
      if (mappedReason) {
        return mappedReason;
      }
    }

    const statusFromBody = error?.status?.trim().toUpperCase();
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
      lowerBody.includes('model capacity exhausted') ||
      lowerBody.includes('no capacity available')
    ) {
      return RateLimitReason.ModelCapacityExhausted;
    }

    const hasGenericResourceExhausted =
      statusFromBody === 'RESOURCE_EXHAUSTED' || hasGenericResourceExhaustedSignal(body);
    const hasBareQuotaExhausted = lowerBody.includes('quota_exhausted');
    const hasDelayedBareQuotaExhausted =
      hasBareQuotaExhausted && parseRetryDelay(body, retryAfter) !== null;
    const hasDurableQuotaExhausted = hasDurableQuotaExhaustedSignal(body);
    if (
      lowerBody.includes('per minute') ||
      lowerBody.includes('rate limit') ||
      lowerBody.includes('rate_limit') ||
      lowerBody.includes('too many requests') ||
      (hasGenericResourceExhausted && !hasDurableQuotaExhausted && !hasDelayedBareQuotaExhausted)
    ) {
      return RateLimitReason.RateLimitExceeded;
    }
    if (hasDurableQuotaExhausted || hasDelayedBareQuotaExhausted) {
      return RateLimitReason.QuotaExhausted;
    }
    if (hasBareQuotaExhausted || lowerBody.includes('quota')) {
      return RateLimitReason.RateLimitExceeded;
    }

    return RateLimitReason.Unknown;
  }

  private computeRetryAfterSeconds(params: {
    reason: RateLimitReason;
    status: number;
    retryAfter?: string;
    body?: string;
    accountId: string;
    model?: string;
    backoffSteps: number[];
  }): number {
    const explicitRetry = parseRetryDelay(params.body, params.retryAfter);
    if (explicitRetry !== null) {
      return Math.max(2, Math.ceil(explicitRetry.delayMs / 1000));
    }

    const failureCount =
      params.reason !== RateLimitReason.ServerError
        ? this.incrementFailureCount(
            this.buildFailureCountKey(params.accountId, params.reason, params.model),
          )
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
      return Math.ceil(deepParsedRetry / 1000);
    }

    const parsedBody = tryParseGoogleErrorBody(body);
    const error = getGoogleErrorEnvelope(parsedBody);
    const details = getGoogleErrorDetails(error);
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

    const retryAfter = error?.retry_after;
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

  private incrementFailureCount(key: string): number {
    const now = Date.now();
    const entry = this.failureCounts.get(key);
    if (!entry) {
      this.failureCounts.set(key, { count: 1, lastFailureMs: now });
      return 1;
    }

    if (now - entry.lastFailureMs > FAILURE_COUNT_EXPIRY_MS) {
      this.failureCounts.set(key, { count: 1, lastFailureMs: now });
      return 1;
    }

    const nextCount = entry.count + 1;
    this.failureCounts.set(key, { count: nextCount, lastFailureMs: now });
    return nextCount;
  }
}
