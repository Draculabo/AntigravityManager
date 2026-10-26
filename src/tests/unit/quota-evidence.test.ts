import { describe, expect, it } from 'vitest';
import type { CloudQuotaBucket } from '@/modules/cloud-account/types';
import {
  quotaBucketReason,
  quotaGroupRestriction,
  formatObservationTime,
} from '@/modules/cloud-account/utils/quota-evidence';
import { getVisibleAccountQuota } from '@/modules/cloud-account/utils/quota-group-visibility';

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
    [bucket(0, '2026-10-17T00:00:00Z'), 'recheck-required'],
    [bucket(0.8, '2026-10-17T00:00:00Z'), 'window-ended'],
    [bucket(0, 'invalid'), 'exhausted-unknown-reset'],
    [bucket(0.8, 'invalid'), 'reset-unknown'],
    [bucket(-1), 'invalid-data'],
    [bucket(1.1), 'invalid-data'],
    [bucket(0.8), undefined],
  ] as const)('uses raw window data: %j', (input, expected) => {
    expect(quotaBucketReason(input, now)).toBe(expected);
  });
  it('uses the latest exhausted reset within each group, excluding positive windows', () => {
    const weekly = bucket();
    expect(
      quotaGroupRestriction(
        { display_name: 'Claude', buckets: [weekly, bucket(0, '2026-10-17T01:00:00Z', '5h')] },
        now,
      ),
    ).toEqual({ state: 'group-limited', resetTime: '2026-10-20T00:00:00.000Z' });
    expect(
      quotaGroupRestriction(
        { display_name: 'Gemini', buckets: [bucket(0.8), bucket(0, '2026-10-17T01:00:00Z', '5h')] },
        now,
      ),
    ).toEqual({ state: 'group-limited', resetTime: '2026-10-17T01:00:00.000Z' });
    expect(
      quotaGroupRestriction({ display_name: 'Other', buckets: [bucket(0.8)] }, now),
    ).toBeNull();
  });
  it('does not report recovery when an exhausted window expires or has an unknown reset', () => {
    expect(
      quotaGroupRestriction(
        { display_name: 'Claude', buckets: [bucket(0, '2026-10-17T00:00:00Z')] },
        now,
      ),
    ).toEqual({ state: 'recheck-required' });
    expect(
      quotaGroupRestriction({ display_name: 'Claude', buckets: [bucket(0, 'invalid')] }, now),
    ).toEqual({ state: 'exhausted-unknown-reset' });
  });
  it('retains a visible family restriction across window hiding but respects fully hidden families', () => {
    const quota = {
      models: {},
      quota_groups: [
        {
          display_name: 'Claude Models',
          buckets: [bucket(), bucket(0.8, '2026-10-20T00:00:00Z', '5h')],
        },
      ],
    };
    const result = getVisibleAccountQuota(
      quota,
      {},
      { fiveHour: { gemini: false, claude: true }, weekly: { gemini: false, claude: false } },
    );
    expect(result.weeklyItems).toEqual([]);
    expect(result.restrictionGroups).toEqual(quota.quota_groups);
    expect(
      getVisibleAccountQuota(
        quota,
        {},
        { fiveHour: { gemini: false, claude: false }, weekly: { gemini: false, claude: false } },
      ).restrictionGroups,
    ).toEqual([]);
  });
  it('keeps legacy, malformed and out-of-range observation times unknown', () => {
    for (const time of [undefined, -1, NaN, Number.MAX_SAFE_INTEGER]) {
      expect(formatObservationTime(time)).toBeUndefined();
    }
    expect(formatObservationTime(now)).toBe(new Date(now).toLocaleString());
  });
});
