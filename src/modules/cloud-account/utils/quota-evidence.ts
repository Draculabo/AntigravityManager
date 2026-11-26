import type { CloudQuotaBucket } from '../types';
import { isExhaustedQuotaWindow, isWeeklyWindow } from './quota-windows';

export function formatObservationTime(value: number | undefined): string | undefined {
  if (value === undefined || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toLocaleString();
}

/** Presentation uses the same raw-fraction exhaustion rule as scheduling, without inventing a TTL. */
export function quotaBucketReason(bucket: CloudQuotaBucket, now: number) {
  if (
    !Number.isFinite(bucket.remaining_fraction) ||
    bucket.remaining_fraction < 0 ||
    bucket.remaining_fraction > 1
  ) {
    return 'invalid-data';
  }
  const reset = Date.parse(bucket.reset_time);
  const exhausted = isExhaustedQuotaWindow(bucket);
  if (!Number.isFinite(reset)) {
    return exhausted ? 'exhausted-unknown-reset' : 'reset-unknown';
  }
  if (reset <= now) {
    return undefined;
  }
  if (exhausted) {
    return isWeeklyWindow(bucket) ? 'weekly-exhausted' : 'window-exhausted';
  }
  if (bucket.remaining_fraction > 0 && Math.round(bucket.remaining_fraction * 100) === 0) {
    return 'small-positive';
  }
  return undefined;
}
