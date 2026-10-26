import { z } from 'zod';
import type { CloudQuotaBucket } from '../types';
import { isWeeklyWindow } from './quota-windows';

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const resetInstant = z.iso.datetime({ offset: true });

export type WeeklyQuotaCycle =
  | { state: 'available'; from: number; to: number }
  | { state: 'unavailable'; reason: 'not-weekly' | 'invalid-reset' | 'expired' | 'not-started' };

/** Provider reset defines [reset - 7 days, reset); never synthesize a following cycle. */
export function weeklyQuotaCycle(bucket: CloudQuotaBucket, now: number): WeeklyQuotaCycle {
  if (!isWeeklyWindow(bucket)) {
    return { state: 'unavailable', reason: 'not-weekly' };
  }
  // A local time without an offset cannot identify the same provider cycle across hosts.
  if (!resetInstant.safeParse(bucket.reset_time).success) {
    return { state: 'unavailable', reason: 'invalid-reset' };
  }
  const to = Date.parse(bucket.reset_time);
  const from = to - WEEK_MS;
  if (!Number.isSafeInteger(to) || from < 0) {
    return { state: 'unavailable', reason: 'invalid-reset' };
  }
  if (to <= now) {
    return { state: 'unavailable', reason: 'expired' };
  }
  if (from > now) {
    return { state: 'unavailable', reason: 'not-started' };
  }
  return { state: 'available', from, to };
}
