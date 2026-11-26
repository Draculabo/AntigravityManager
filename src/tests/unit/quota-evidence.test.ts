import { describe, expect, it } from 'vitest';
import type { CloudQuotaBucket } from '@/modules/cloud-account/types';
import {
  formatObservationTime,
  quotaBucketReason,
} from '@/modules/cloud-account/utils/quota-evidence';

const now = Date.parse('2026-10-17T00:00:00Z');
function bucket(
  remaining_fraction = 0,
  reset_time = '2026-10-20T00:00:00Z',
  window = 'weekly',
): CloudQuotaBucket {
  return { bucket_id: window, window, remaining_fraction, reset_time };
}
describe('quota evidence presentation', () => {
  it.each([
    [bucket(0), 'weekly-exhausted'],
    [bucket(0.001), 'weekly-exhausted'],
    [bucket(0.004), 'small-positive'],
    [bucket(0.004, '2026-10-20T00:00:00Z', '5h'), 'small-positive'],
    [bucket(0, '2026-10-20T00:00:00Z', '5h'), 'window-exhausted'],
    [bucket(0, '2026-10-17T00:00:00Z'), undefined],
    [bucket(0.8, '2026-10-17T00:00:00Z'), undefined],
    [bucket(0, 'invalid'), 'exhausted-unknown-reset'],
    [bucket(0.8, 'invalid'), 'reset-unknown'],
    [bucket(-1), 'invalid-data'],
    [bucket(1.1), 'invalid-data'],
    [bucket(0.8), undefined],
  ] as const)('uses raw window data: %j', (input, expected) => {
    expect(quotaBucketReason(input, now)).toBe(expected);
  });
  it('keeps legacy, malformed and out-of-range observation times unknown', () => {
    for (const time of [undefined, -1, NaN, Number.MAX_SAFE_INTEGER]) {
      expect(formatObservationTime(time)).toBeUndefined();
    }
    expect(formatObservationTime(now)).toBe(new Date(now).toLocaleString());
  });
});
