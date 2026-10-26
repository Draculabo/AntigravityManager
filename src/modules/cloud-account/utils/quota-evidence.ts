import type { CloudQuotaBucket, CloudQuotaGroup } from '../types';
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
    return exhausted ? 'recheck-required' : 'window-ended';
  }
  if (exhausted) {
    return isWeeklyWindow(bucket) ? 'weekly-exhausted' : 'window-exhausted';
  }
  if (bucket.remaining_fraction > 0 && Math.round(bucket.remaining_fraction * 100) === 0) {
    return 'small-positive';
  }
  return undefined;
}

interface GroupRestriction {
  state: 'group-limited' | 'exhausted-unknown-reset' | 'recheck-required';
  resetTime?: string;
}

/** Groups stay independent. A reset is a known waiting boundary, not proof of recovery. */
export function quotaGroupRestriction(
  group: CloudQuotaGroup,
  now: number,
): GroupRestriction | null {
  const depleted = group.buckets.filter(isExhaustedQuotaWindow);
  if (!depleted.length) {
    return null;
  }
  const latest = depleted.reduce((value, bucket) => {
    const reset = Date.parse(bucket.reset_time);
    return Number.isFinite(reset) && reset > now ? Math.max(value, reset) : value;
  }, 0);
  if (latest > now) {
    return {
      state: 'group-limited' as const,
      resetTime: new Date(latest).toISOString(),
    };
  }
  return {
    state: depleted.some((bucket) => !Number.isFinite(Date.parse(bucket.reset_time)))
      ? ('exhausted-unknown-reset' as const)
      : ('recheck-required' as const),
  };
}
