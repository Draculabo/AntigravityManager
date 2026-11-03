import { describe, expect, it, vi } from 'vitest';

import {
  applyQuotaLowerBound,
  collectQuotaGroupBucketPercentages,
  getDedicatedQuotaGroupFamilyId,
  getMinimumQuotaPercentage,
  isWeeklyQuotaBucket,
  populateSyntheticArgonModels,
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

  it('limits a group named after one model family to that family', () => {
    // Shape of the Google AI Pro quota summary returned to the Antigravity hub client.
    const proGroups: CloudQuotaGroup[] = [
      {
        display_name: 'Gemini Models',
        description: 'Models within this group: Gemini Flash, Gemini Pro',
        buckets: [
          {
            bucket_id: 'gemini-weekly',
            window: 'weekly',
            remaining_fraction: 0.59,
            reset_time: '2026-10-30T06:50:31Z',
            display_name: 'Weekly Limit Remaining',
          },
        ],
      },
      {
        display_name: 'Gemini 4 Argon',
        description:
          'For paid Pro plans, Argon quota is separate. Higher Argon quota (included as part of the larger Gemini quota bucket) is available on Ultra plans.',
        buckets: [
          {
            bucket_id: 'gemini-argon-wtu-weekly',
            window: 'weekly',
            remaining_fraction: 0,
            reset_time: '2026-10-30T06:50:31Z',
            display_name: 'Gemini 4 Argon Weekly Limit',
          },
        ],
      },
    ];

    expect({
      argonFamily: getDedicatedQuotaGroupFamilyId(proGroups[1]),
      providerGroupFamily: getDedicatedQuotaGroupFamilyId(proGroups[0]),
      flashCohort: collectQuotaGroupBucketPercentages(proGroups, [
        'gemini-3.8-flash-high',
        'gemini',
      ]),
      argonCohort: collectQuotaGroupBucketPercentages(proGroups, ['models/gemini-4-argon-high']),
      providerContext: selectWeeklyQuotaItems(proGroups, ['gemini']).map((item) => item.groupName),
      unfiltered: selectWeeklyQuotaItems(proGroups).map(
        ({ groupName, bucketLabel, percentage }) => ({
          groupName,
          bucketLabel,
          percentage,
        }),
      ),
    }).toEqual({
      argonFamily: 'gemini-4-argon',
      providerGroupFamily: undefined,
      flashCohort: [59],
      argonCohort: [0],
      providerContext: ['Gemini'],
      unfiltered: [
        { groupName: 'Gemini', bucketLabel: 'Weekly Limit Remaining', percentage: 59 },
        {
          groupName: 'Gemini 4 Argon',
          bucketLabel: 'Gemini 4 Argon Weekly Limit',
          percentage: 0,
        },
      ],
    });
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

  it('synthesizes gemini-4-argon-high when dedicated Argon group is present and models omits Argon', () => {
    const models: Record<string, any> = {
      'gemini-3.8-flash-high': {
        percentage: 80,
        resetTime: '2026-11-01T00:00:00Z',
      },
    };
    const argonGroups: CloudQuotaGroup[] = [
      {
        display_name: 'Gemini 4 Argon',
        buckets: [
          {
            bucket_id: 'gemini-argon-wtu-weekly',
            window: 'weekly',
            remaining_fraction: 0.75,
            reset_time: '2026-11-08T12:00:00Z',
            display_name: 'Gemini 4 Argon Weekly Limit',
          },
        ],
      },
    ];

    populateSyntheticArgonModels(models, argonGroups);

    expect(models['gemini-4-argon-high']).toEqual({
      percentage: 75,
      resetTime: '2026-11-08T12:00:00Z',
      display_name: 'Gemini 4 Argon (High)',
      supports_images: true,
      supports_thinking: true,
      thinking_budget: 49152,
      recommended: false,
      max_tokens: 1048576,
      max_output_tokens: 65536,
    });
  });

  it('preserves existing Argon model when already present in models map', () => {
    const models: Record<string, any> = {
      'gemini-4-argon-high': {
        percentage: 95,
        resetTime: '2026-11-02T00:00:00Z',
        display_name: 'Custom Argon',
      },
    };
    const argonGroups: CloudQuotaGroup[] = [
      {
        display_name: 'Gemini 4 Argon',
        buckets: [
          {
            bucket_id: 'gemini-argon-wtu-weekly',
            window: 'weekly',
            remaining_fraction: 0.2,
            reset_time: '2026-11-09T00:00:00Z',
          },
        ],
      },
    ];

    populateSyntheticArgonModels(models, argonGroups);

    expect(models['gemini-4-argon-high'].percentage).toBe(95);
    expect(models['gemini-4-argon-high'].display_name).toBe('Custom Argon');
  });

  it('does not synthesize Argon when no Argon group is in quota groups', () => {
    const models: Record<string, any> = {
      'gemini-3.8-flash-high': { percentage: 80, resetTime: '' },
    };
    const normalGroups: CloudQuotaGroup[] = [
      {
        display_name: 'Gemini Models',
        buckets: [
          {
            bucket_id: 'gemini-weekly',
            window: 'weekly',
            remaining_fraction: 0.5,
            reset_time: '',
          },
        ],
      },
    ];

    populateSyntheticArgonModels(models, normalGroups);

    expect(models['gemini-4-argon-high']).toBeUndefined();
  });
});

describe('quota-window preference', () => {
  it('defaults invalid or unavailable storage values to the combined view', () => {
    expect(readQuotaWindowPreference({ getItem: () => 'unexpected', setItem: vi.fn() })).toBe(
      'both',
    );
    expect(
      readQuotaWindowPreference({
        getItem: () => {
          throw new Error('storage disabled');
        },
        setItem: vi.fn(),
      }),
    ).toBe('both');
  });

  it('round-trips every quota-window preference without throwing when writes are blocked', () => {
    const setItem = vi.fn();
    saveQuotaWindowPreference({ getItem: () => null, setItem }, 'weekly');
    expect(setItem).toHaveBeenCalledExactlyOnceWith(QUOTA_WINDOW_STORAGE_KEY, 'weekly');
    expect(readQuotaWindowPreference({ getItem: () => 'both', setItem: vi.fn() })).toBe('both');

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
