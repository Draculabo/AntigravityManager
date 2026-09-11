import { describe, expect, it, vi } from 'vitest';

import {
  applyQuotaLowerBound,
  collectQuotaGroupBucketPercentages,
  getMinimumQuotaPercentage,
  isWeeklyQuotaBucket,
  selectWeeklyQuotaItems,
} from '@/modules/cloud-account/utils/quota-groups';
import {
  QUOTA_WINDOW_STORAGE_KEY,
  readQuotaWindowPreference,
  saveQuotaWindowPreference,
} from '@/modules/cloud-account/utils/quota-window-preference';
import type { CloudQuotaGroup } from '@/modules/cloud-account/types';

const groups: CloudQuotaGroup[] = [
  {
    display_name: 'Claude Models',
    description: 'Anthropic models',
    buckets: [
      {
        bucket_id: 'claude-5h',
        window: '5h',
        remaining_fraction: 0.55,
        reset_time: '2026-08-31T12:00:00Z',
      },
      {
        bucket_id: 'claude-weekly',
        window: '7d',
        remaining_fraction: 0.999,
        reset_time: '2026-09-01T00:00:00Z',
        display_name: 'Weekly requests',
      },
    ],
  },
  {
    display_name: 'Gemini Models',
    buckets: [
      {
        bucket_id: 'gemini-long-window',
        window: 'WEEKLY',
        remaining_fraction: 0.42,
        reset_time: '2026-09-02T00:00:00Z',
      },
    ],
  },
];

describe('weekly quota groups', () => {
  it('recognizes weekly buckets from either the window or bucket id, case-insensitively', () => {
    expect(isWeeklyQuotaBucket(groups[0].buckets[0])).toBe(false);
    expect(isWeeklyQuotaBucket(groups[0].buckets[1])).toBe(true);
    expect(isWeeklyQuotaBucket(groups[1].buckets[0])).toBe(true);
  });

  it('selects only weekly buckets and produces stable display values', () => {
    expect(selectWeeklyQuotaItems(groups)).toEqual([
      expect.objectContaining({
        groupName: 'Claude',
        groupDescription: 'Anthropic models',
        bucketLabel: 'Weekly requests',
        percentage: 100,
        resetTime: '2026-09-01T00:00:00Z',
      }),
      expect.objectContaining({
        groupName: 'Gemini',
        bucketLabel: 'WEEKLY',
        percentage: 42,
        resetTime: '2026-09-02T00:00:00Z',
      }),
    ]);
  });
});

describe('quota group score primitives', () => {
  it('collects every bucket from every positively matched group', () => {
    expect(collectQuotaGroupBucketPercentages(groups, ['models/CLAUDE'])).toEqual([55, 100]);
    expect(getMinimumQuotaPercentage([55, 100])).toBe(55);
  });

  it('matches bucket metadata when the group metadata is not specific', () => {
    const genericGroups: CloudQuotaGroup[] = [
      {
        display_name: 'Shared limits',
        buckets: [
          {
            bucket_id: '3p-5h',
            window: '5h',
            remaining_fraction: 0.8,
            reset_time: '',
          },
          {
            bucket_id: 'claude-weekly',
            window: 'weekly',
            remaining_fraction: 0.06,
            reset_time: '',
          },
        ],
      },
    ];

    expect(collectQuotaGroupBucketPercentages(genericGroups, ['claude', '3p'])).toEqual([80, 6]);
  });

  it('does not infer an unrelated provider when no token matches', () => {
    expect(collectQuotaGroupBucketPercentages(groups, ['vendor-experimental-v9'])).toEqual([]);
  });

  it('combines nullable model and group scores without treating a real zero as missing', () => {
    expect({
      both: applyQuotaLowerBound(75, 20),
      modelOnly: applyQuotaLowerBound(75, null),
      groupOnly: applyQuotaLowerBound(null, 20),
      realZero: applyQuotaLowerBound(0, 20),
      neither: applyQuotaLowerBound(null, null),
    }).toEqual({
      both: 20,
      modelOnly: 75,
      groupOnly: 20,
      realZero: 0,
      neither: null,
    });
  });
});

describe('quota-window preference', () => {
  it('defaults invalid or unavailable storage values to the five-hour view', () => {
    expect(readQuotaWindowPreference({ getItem: () => 'unexpected', setItem: vi.fn() })).toBe('5h');
    expect(
      readQuotaWindowPreference({
        getItem: () => {
          throw new Error('storage disabled');
        },
        setItem: vi.fn(),
      }),
    ).toBe('5h');
  });

  it('round-trips the weekly preference without throwing when writes are blocked', () => {
    const setItem = vi.fn();
    saveQuotaWindowPreference({ getItem: () => null, setItem }, 'weekly');
    expect(setItem).toHaveBeenCalledExactlyOnceWith(QUOTA_WINDOW_STORAGE_KEY, 'weekly');

    expect(() =>
      saveQuotaWindowPreference(
        {
          getItem: () => null,
          setItem: () => {
            throw new Error('storage disabled');
          },
        },
        '5h',
      ),
    ).not.toThrow();
  });
});
