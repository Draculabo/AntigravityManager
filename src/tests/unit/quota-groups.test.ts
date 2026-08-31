import { describe, expect, it, vi } from 'vitest';

import {
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
