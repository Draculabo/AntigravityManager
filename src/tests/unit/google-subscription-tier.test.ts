import { afterEach, describe, expect, it, vi } from 'vitest';
import { mockAxiosRequests } from '../helpers/mock-axios-request';
import { mergeQuotaWindows } from '@/modules/cloud-account/utils/quota-windows';
import type { CloudQuotaData } from '@/modules/cloud-account/types';

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

function transport(project: object, failProject = false) {
  const request = vi.fn(async (url: string) => ({
    status: url.includes('loadCodeAssist') && failProject ? 503 : 200,
    json: async () =>
      url.includes('loadCodeAssist')
        ? project
        : url.includes('retrieveUserQuotaSummary')
          ? { groups: [] }
          : { models: { 'claude-sonnet-4-6': { quotaInfo: { remainingFraction: 0.8 } } } },
  }));
  mockAxiosRequests(request);
  return request;
}

describe('authoritative subscription identity', () => {
  it.each([
    { paidTier: null, currentTier: { id: 'g1-pro-tier' } },
    { paidTier: { id: null, name: 'Google AI Pro' } },
    { cloudaicompanionProject: null, paidTier: { id: 'g1-pro-tier' } },
  ])('treats null optional project/tier fields as absent: %j', async (fields) => {
    transport(fields);
    const { GoogleAPIService } = await import('@/modules/cloud-account/services/GoogleAPIService');
    expect(
      (await GoogleAPIService.fetchQuota('synthetic-subscription-access')).subscription_tier,
    ).toBe('pro');
  });

  it('records a missing-source baseline when nullable authority fields are all absent', async () => {
    transport({ paidTier: null, currentTier: null, allowedTiers: null, ineligibleTiers: null });
    const { GoogleAPIService } = await import('@/modules/cloud-account/services/GoogleAPIService');
    const quota = await GoogleAPIService.fetchQuota('synthetic-subscription-access');
    expect(quota.subscription_tier).toBe('free');
    expect(quota.subscription?.observation?.status).toBe('missing');
  });

  it.each([
    [{ paidTier: { id: 'free-tier', name: 'Google AI Pro' } }, 'free'],
    [{ paidTier: { id: 'g1-pro-tier', name: 'Google AI Ultra' } }, 'pro'],
    [{ paidTier: { id: 'g1-ultra-tier' }, currentTier: { id: 'free-tier' } }, 'ultra'],
    [{ paidTier: { id: 'standard-tier', name: 'Google AI Pro' } }, 'free'],
    [{ paidTier: { id: 'future-pro-account', name: 'Pro' } }, 'free'],
    [{ paidTier: { name: 'Google AI Pro' } }, 'pro'],
    [{ paidTier: { id: ' ', name: 'Google AI Ultra' } }, 'ultra'],
    [
      {
        currentTier: { id: 'g1-pro-tier', name: 'Free' },
        ineligibleTiers: [{ reasonCode: 'LOCATION' }],
      },
      'pro',
    ],
    [{ allowedTiers: [{ id: 'g1-pro-tier', is_default: true }] }, 'free'],
    [{ allowedTiers: [{ name: 'Ultra' }] }, 'free'],
    [{ allowedTiers: [{ id: 'free-tier' }] }, 'free'],
    [{ currentTier: { name: 'professional promotion' } }, 'free'],
    [{}, 'free'],
  ] as const)('resolves only known identity evidence: %j', async (tier, expected) => {
    transport({ cloudaicompanionProject: 'synthetic-cached-project', ...tier });
    const { GoogleAPIService } = await import('@/modules/cloud-account/services/GoogleAPIService');
    const quota = await GoogleAPIService.fetchQuota('synthetic-subscription-access');
    expect(quota.subscription_tier).toBe(expected);
  });

  it('preserves a prior paid tier on discovery failure without treating visible models as proof', async () => {
    transport({}, true);
    const { GoogleAPIService } = await import('@/modules/cloud-account/services/GoogleAPIService');
    const previous: CloudQuotaData = { models: {}, subscription_tier: 'pro' };
    const quota = await GoogleAPIService.fetchQuota('synthetic-subscription-access');
    const merged = mergeQuotaWindows(previous, quota);
    expect(merged.subscription_tier).toBe('pro');
    expect(merged.models['claude-sonnet-4-6']).toBeDefined();
    expect(merged.subscription?.refresh_status).toBe('failed');
  });

  it('records an unrecognized ID independently of names', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(200);
    transport({ paidTier: { id: 'standard-tier', name: 'Google AI Pro' } });
    const { GoogleAPIService } = await import('@/modules/cloud-account/services/GoogleAPIService');
    const context = await GoogleAPIService.fetchProjectContext('synthetic-subscription-access');
    expect(context).toEqual({
      projectId: undefined,
      subscriptionTier: 'free',
      subscription: {
        refresh_status: 'succeeded',
        checked_at: 200,
        observation: {
          status: 'unrecognized',
          tier: 'free',
          source: 'paid-tier-id',
          raw_value: 'standard-tier',
          observed_at: 200,
        },
      },
    });
  });

  it('normalizes an explicit name fallback while retaining its exact raw value and source', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(200);
    transport({ paidTier: { name: ' Google AI Pro ' } });
    const { GoogleAPIService } = await import('@/modules/cloud-account/services/GoogleAPIService');
    expect(
      (await GoogleAPIService.fetchQuota('synthetic-subscription-access')).subscription,
    ).toEqual({
      refresh_status: 'succeeded',
      checked_at: 200,
      observation: {
        status: 'known',
        tier: 'pro',
        source: 'paid-tier-name',
        raw_value: ' Google AI Pro ',
        observed_at: 200,
      },
    });
  });

  it('rejects oversized identity input without truncating it into a recognized paid tier', async () => {
    transport({ paidTier: { id: 'g1-pro-tier' + ' '.repeat(256) } });
    const { GoogleAPIService } = await import('@/modules/cloud-account/services/GoogleAPIService');
    const quota = await GoogleAPIService.fetchQuota('synthetic-subscription-access');
    expect(quota.subscription_tier).toBeUndefined();
    expect(quota.subscription?.refresh_status).toBe('failed');
  });

  it('refreshes subscription even when the project was already discovered and accepts a fresh downgrade', async () => {
    let paid = true;
    const request = vi.fn(async (url: string) => ({
      status: 200,
      json: async () =>
        url.includes('loadCodeAssist')
          ? {
              cloudaicompanionProject: 'synthetic-cached-project',
              paidTier: { id: paid ? 'g1-pro-tier' : 'free-tier' },
            }
          : { models: {} },
    }));
    mockAxiosRequests(request);
    const { GoogleAPIService } = await import('@/modules/cloud-account/services/GoogleAPIService');
    expect(await GoogleAPIService.fetchProjectId('synthetic-subscription-access')).toBe(
      'synthetic-cached-project',
    );
    const prior = await GoogleAPIService.fetchQuota('synthetic-subscription-access');
    paid = false;
    const next = await GoogleAPIService.fetchQuota('synthetic-subscription-access');
    expect(mergeQuotaWindows(prior, next).subscription_tier).toBe('free');
    expect(request.mock.calls.filter(([url]) => url.includes('loadCodeAssist'))).toHaveLength(3);
  });
});
