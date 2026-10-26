import { afterEach, describe, expect, it, vi } from 'vitest';
import { mockAxiosRequests } from '../helpers/mock-axios-request';

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('quota summary boundary evidence', () => {
  it('records one local observation instant for successfully decoded buckets', async () => {
    const observedAt = 1_800_000_000_000;
    vi.spyOn(Date, 'now').mockReturnValue(observedAt);
    const payload = {
      groups: [
        {
          displayName: 'Claude',
          buckets: [
            {
              bucketId: '3p-5h',
              window: '5h',
              remainingFraction: 0.8,
              resetTime: '2090-01-01T01:00:00Z',
              observed_at: 1,
            },
            {
              bucketId: '3p-week',
              window: 'weekly',
              remainingFraction: 0,
              resetTime: '2090-01-04T00:00:00Z',
              observed_at: 1,
            },
          ],
        },
      ],
    };
    const before = structuredClone(payload);
    mockAxiosRequests(
      vi.fn(async (url: string) => ({
        status: 200,
        json: async () =>
          url.includes('loadCodeAssist')
            ? { cloudaicompanionProject: 'synthetic-observation-project' }
            : url.includes('retrieveUserQuotaSummary')
              ? payload
              : {
                  models: {
                    'claude-sonnet-4-6': {
                      quotaInfo: { remainingFraction: 0.8, resetTime: '2090-01-01T01:00:00Z' },
                    },
                  },
                },
      })),
    );
    const { GoogleAPIService } = await import('@/modules/cloud-account/services/GoogleAPIService');
    const result = await GoogleAPIService.fetchQuota('synthetic-observation-access');
    expect(result.quota_groups).toEqual([
      {
        display_name: 'Claude',
        description: undefined,
        buckets: [
          {
            bucket_id: '3p-5h',
            window: '5h',
            remaining_fraction: 0.8,
            reset_time: '2090-01-01T01:00:00Z',
            observed_at: observedAt,
            display_name: undefined,
            description: undefined,
          },
          {
            bucket_id: '3p-week',
            window: 'weekly',
            remaining_fraction: 0,
            reset_time: '2090-01-04T00:00:00Z',
            observed_at: observedAt,
            display_name: undefined,
            description: undefined,
          },
        ],
      },
    ]);
    expect(payload).toEqual(before);
  });

  it.each([undefined, -0.1, 1.1])(
    'does not turn missing or invalid fraction %s into zero quota',
    async (fraction) => {
      const transport = vi.fn(async (url: string) => ({
        status: 200,
        json: async () => {
          if (url.includes('loadCodeAssist')) {
            return { cloudaicompanionProject: 'synthetic-project' };
          }
          if (url.includes('retrieveUserQuotaSummary')) {
            return {
              groups: [
                {
                  displayName: 'Claude',
                  buckets: [
                    {
                      bucketId: 'weekly',
                      window: '7d',
                      remainingFraction: fraction,
                      resetTime: '2090-01-04T00:00:00Z',
                    },
                  ],
                },
              ],
            };
          }
          return {
            models: {
              'claude-sonnet-4-6': {
                quotaInfo: {
                  remainingFraction: 0.8,
                  resetTime: '2090-01-01T01:00:00Z',
                },
              },
            },
          };
        },
      }));
      mockAxiosRequests(transport);
      const { GoogleAPIService } =
        await import('@/modules/cloud-account/services/GoogleAPIService');
      const result = await GoogleAPIService.fetchQuota('synthetic-summary-access');
      expect(result.models['claude-sonnet-4-6'].percentage).toBe(80);
      expect(result.quota_groups?.flatMap((group) => group.buckets) ?? []).toEqual([]);
      expect(transport.mock.calls.some(([url]) => url.includes('retrieveUserQuotaSummary'))).toBe(
        true,
      );
    },
  );
});
