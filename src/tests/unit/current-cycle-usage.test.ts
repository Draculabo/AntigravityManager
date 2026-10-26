import { describe, expect, it } from 'vitest';
import type { CloudQuotaGroup } from '@/modules/cloud-account/types';
import {
  buildCurrentCycleUsageRequests,
  type CurrentCycleUsageRequest,
} from '@/modules/cloud-account/utils/current-cycle-usage';

const now = Date.parse('2026-10-19T12:00:00Z');
const reset = '2026-10-21T12:00:00Z';

function group(overrides: Partial<CloudQuotaGroup> = {}) {
  return {
    display_name: 'Gemini Models',
    model_ids: ['models/gemini-3-flash', ' GEMINI-3-PRO '],
    buckets: [
      {
        bucket_id: 'weekly',
        window: 'weekly',
        remaining_fraction: 0.8,
        reset_time: reset,
      },
    ],
    ...overrides,
  };
}

describe('current official cycle usage request planning', () => {
  it('uses only explicit physical group membership and normalizes IDs', () => {
    expect(buildCurrentCycleUsageRequests([group()], now)).toEqual<CurrentCycleUsageRequest[]>([
      {
        id: 'Gemini Models:1791979200000:1792584000000:gemini-3-flash,gemini-3-pro',
        groupName: 'Gemini Models',
        modelIds: ['gemini-3-flash', 'gemini-3-pro'],
        from: Date.parse(reset) - 7 * 24 * 60 * 60 * 1000,
        to: Date.parse(reset),
      },
    ]);
  });

  it('does not query label-only legacy groups or expired cycles', () => {
    expect(
      buildCurrentCycleUsageRequests(
        [
          group({ model_ids: undefined }),
          group({
            display_name: 'Expired',
            buckets: [
              {
                bucket_id: 'weekly',
                window: 'weekly',
                remaining_fraction: 0,
                reset_time: '2026-10-18T12:00:00Z',
              },
            ],
          }),
        ],
        now,
      ),
    ).toEqual([]);
  });

  it('deduplicates repeated weekly buckets with the same physical scope', () => {
    const duplicate = group({
      buckets: [
        {
          bucket_id: 'weekly',
          window: 'WEEKLY',
          remaining_fraction: 0.8,
          reset_time: reset,
        },
        {
          bucket_id: 'weekly-alias',
          window: '7d',
          remaining_fraction: 0.7,
          reset_time: reset,
        },
      ],
    });
    expect(buildCurrentCycleUsageRequests([duplicate], now)).toHaveLength(1);
  });
});
