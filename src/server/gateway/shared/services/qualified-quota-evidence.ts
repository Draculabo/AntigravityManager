import { hasStrictQuotaExhaustedMarker, parseRetryDelayMilliseconds } from './rate-limit-evidence';

interface QuotaDeadlineEvidence {
  status?: number;
  reason: string;
  modelId: string;
  message?: string;
  unavailableUntil: number;
  detectedAt: number;
}

/** The original observation qualifies a deadline even when fewer than five minutes remain. */
export function hasQualifiedQuotaDeadline(entry: QuotaDeadlineEvidence, now = Date.now()): boolean {
  return (
    entry.status === 429 &&
    entry.reason === 'quota_exhausted' &&
    entry.modelId.trim() !== '' &&
    entry.unavailableUntil > now &&
    entry.unavailableUntil - entry.detectedAt > 300_000 &&
    hasStrictQuotaExhaustedMarker(entry.message) &&
    (parseRetryDelayMilliseconds(entry.message) ?? 0) > 300_000
  );
}
