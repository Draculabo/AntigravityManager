import { isEmpty, isNumber, isString } from 'lodash-es';
import { z } from 'zod';
import { RateLimitReason, type ParsedRetryDelay } from './rate-limit-types';

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

const MAX_RETRY_DELAY_SEARCH_DEPTH = 8;
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
  return lowerBody.includes('quota_exhausted') || hasDurableQuotaExhaustedSignal(body);
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
    lowerBody.includes('daily quota') ||
    lowerBody.includes('quota exhausted') ||
    lowerBody.includes('weekly quota') ||
    lowerBody.includes('per week') ||
    lowerBody.includes('credits exhausted') ||
    lowerBody.includes('insufficient credits')
  );
}

export function hasStrictQuotaExhaustedMarker(body: string | undefined): boolean {
  return toLowerText(body).includes('quota_exhausted');
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

function extractEmbeddedDurationRecursive(value: unknown, depth: number): number | null {
  if (depth > MAX_RETRY_DELAY_SEARCH_DEPTH) {
    return null;
  }
  if (isString(value)) {
    return parseDurationToMilliseconds(value);
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const delay = extractEmbeddedDurationRecursive(item, depth + 1);
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
    const delay = extractEmbeddedDurationRecursive(childValue, depth + 1);
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

export function parseAnthropicRetryDelayMilliseconds(errorText: string | undefined): number | null {
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
  return parsedBody ? extractEmbeddedDurationRecursive(parsedBody, 0) : null;
}

export function shouldGraceRetry(delayMs: number): boolean {
  return delayMs > 0 && delayMs <= GRACE_RETRY_WINDOW_MS;
}

export function classifyUpstreamRateLimit(
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
    lowerBody.includes('model_capacity_exhausted') ||
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
