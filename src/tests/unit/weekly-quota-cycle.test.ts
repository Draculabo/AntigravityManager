import { describe, expect, it } from 'vitest';
import { weeklyQuotaCycle } from '@/modules/cloud-account/utils/weekly-quota-cycle';
import type { CloudQuotaBucket } from '@/modules/cloud-account/types';

const to = Date.parse('2026-10-20T00:00:00Z');
const from = to - 7 * 24 * 60 * 60 * 1000;
const bucket: CloudQuotaBucket = {
  bucket_id: 'weekly',
  window: 'weekly',
  remaining_fraction: 0,
  reset_time: new Date(to).toISOString(),
};
describe('official weekly cycle bounds', () => {
  it.each([from, from + 1, to - 1])('keeps the original current cycle at %i', (now) => {
    expect(weeklyQuotaCycle(bucket, now)).toEqual({ state: 'available', from, to });
  });
  it.each([to, to + 1, to + 7 * 24 * 60 * 60 * 1000])(
    'does not synthesize a new cycle at %i',
    (now) => {
      expect(weeklyQuotaCycle(bucket, now)).toEqual({ state: 'unavailable', reason: 'expired' });
    },
  );
  it('rejects a cycle that has not started and preserves seven-day aliases', () => {
    expect(weeklyQuotaCycle(bucket, from - 1)).toEqual({
      state: 'unavailable',
      reason: 'not-started',
    });
    expect(weeklyQuotaCycle({ ...bucket, bucket_id: 'quota', window: '7d' }, from)).toEqual({
      state: 'available',
      from,
      to,
    });
  });
  it('rejects non-weekly or unusable reset evidence', () => {
    expect(weeklyQuotaCycle({ ...bucket, bucket_id: '5h', window: '5h' }, from)).toEqual({
      state: 'unavailable',
      reason: 'not-weekly',
    });
    for (const reset_time of [
      '',
      'bad',
      '1970-01-01T00:00:01Z',
      '2026-10-20T00:00:00',
      '2026-02-30T00:00:00Z',
    ]) {
      expect(weeklyQuotaCycle({ ...bucket, reset_time }, from)).toEqual({
        state: 'unavailable',
        reason: 'invalid-reset',
      });
    }
  });
  it('uses absolute instants across time zones without consulting the current fraction', () => {
    expect(
      weeklyQuotaCycle(
        { ...bucket, reset_time: '2026-10-20T08:00:00+08:00', remaining_fraction: 0.8 },
        from,
      ),
    ).toEqual({ state: 'available', from, to });
  });
});
