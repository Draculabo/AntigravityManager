import { describe, expect, it } from 'vitest';
import { CloudQuotaDataSchema, type CloudQuotaData } from '@/modules/cloud-account/types';
import { mergeQuotaWindows } from '@/modules/cloud-account/utils/quota-windows';
import { observeSubscription } from '@/modules/cloud-account/utils/subscription-tier';
import { projectCloudAccountView } from '@/modules/cloud-account/services/cloud-account-view';

function observed(id: string, time: number): CloudQuotaData {
  const subscription = observeSubscription({ paidTier: { id } }, time);
  return { models: {}, subscription_tier: subscription.observation.tier, subscription };
}

describe('subscription refresh evidence reconciliation', () => {
  it('keeps raw subscription evidence outside the renderer account projection', () => {
    const view = projectCloudAccountView({
      id: 'synthetic-tier',
      provider: 'google',
      email: 'tier@example.test',
      created_at: 1,
      last_used: 1,
      token: {
        access_token: 'synthetic-access',
        refresh_token: 'synthetic-refresh',
        expires_in: 3600,
        expiry_timestamp: 3600,
        token_type: 'Bearer',
      },
      quota: observed('g1-pro-tier', 100),
    });
    expect(view.quota).toEqual({
      models: {},
      subscription_tier: 'pro',
      subscription_status: {
        refresh_status: 'succeeded',
        checked_at: 100,
        observation_status: 'known',
        source: 'paid-tier-id',
        observed_at: 100,
      },
      ai_credits: undefined,
      quota_groups: undefined,
    });
  });
  it('keeps the successful observation on failure without restamping it', () => {
    const previous = observed('g1-pro-tier', 100);
    const failed: CloudQuotaData = {
      models: {},
      subscription: { refresh_status: 'failed', checked_at: 200 },
    };
    const before = structuredClone({ previous, failed });
    const merged = mergeQuotaWindows(previous, failed);
    expect(merged).toEqual({
      models: {},
      subscription_tier: 'pro',
      subscription: {
        refresh_status: 'failed',
        checked_at: 200,
        observation: previous.subscription?.observation,
      },
    });
    expect(CloudQuotaDataSchema.parse(merged)).toEqual(merged);
    expect({ previous, failed }).toEqual(before);
  });

  it('accepts fresh authoritative FREE and rejects older or unobserved rewrites', () => {
    const previous = observed('g1-pro-tier', 200);
    expect(mergeQuotaWindows(previous, observed('free-tier', 100))).toEqual(previous);
    expect(mergeQuotaWindows(previous, { models: {}, subscription_tier: 'ultra' })).toEqual(
      previous,
    );
    const next = observed('free-tier', 300);
    expect(mergeQuotaWindows(previous, next)).toEqual(next);
  });

  it('retains prior identity when a successful project response omits subscription authority', () => {
    const previous = observed('g1-pro-tier', 100);
    const subscription = observeSubscription({ allowedTiers: [{ id: 'g1-ultra-tier' }] }, 200);
    expect(
      mergeQuotaWindows(previous, { models: {}, subscription_tier: 'free', subscription }),
    ).toEqual({
      models: {},
      subscription_tier: 'pro',
      subscription: {
        refresh_status: 'failed',
        checked_at: 200,
        observation: previous.subscription?.observation,
      },
    });
    expect(
      mergeQuotaWindows(undefined, { models: {}, subscription_tier: 'free', subscription }),
    ).toEqual({
      models: {},
      subscription_tier: 'free',
      subscription,
    });
  });

  it('keeps repeated missing-authority observations missing instead of treating a baseline as confirmed history', () => {
    const first = observeSubscription({}, 100);
    const second = observeSubscription({}, 200);
    expect(
      mergeQuotaWindows(
        { models: {}, subscription_tier: 'free', subscription: first },
        { models: {}, subscription_tier: 'free', subscription: second },
      ),
    ).toEqual({ models: {}, subscription_tier: 'free', subscription: second });
  });

  it('uses the safe baseline for an unknown authoritative ID and retains its exact source', () => {
    const subscription = observeSubscription(
      { paidTier: { id: 'standard-tier', name: 'Google AI Pro' } },
      200,
    );
    expect(subscription).toEqual({
      refresh_status: 'succeeded',
      checked_at: 200,
      observation: {
        status: 'unrecognized',
        tier: 'free',
        source: 'paid-tier-id',
        raw_value: 'standard-tier',
        observed_at: 200,
      },
    });
    expect(
      mergeQuotaWindows(observed('g1-pro-tier', 100), {
        models: {},
        subscription_tier: 'pro',
        subscription,
      }).subscription_tier,
    ).toBe('free');
  });

  it('does not fabricate prior evidence for legacy records or a first failed refresh', () => {
    const legacy: CloudQuotaData = { models: {}, subscription_tier: 'pro' };
    const failed: CloudQuotaData = {
      models: {},
      subscription: { refresh_status: 'failed', checked_at: 200 },
    };
    expect(mergeQuotaWindows(legacy, failed)).toEqual({ ...failed, subscription_tier: 'pro' });
    expect(mergeQuotaWindows(undefined, failed)).toEqual({
      ...failed,
      subscription_tier: undefined,
    });
    expect(CloudQuotaDataSchema.parse(legacy)).toEqual(legacy);
  });

  it('does not let a repeated failure replace newer successful identity evidence', () => {
    const current = observed('free-tier', 300);
    const stale: CloudQuotaData = {
      models: {},
      subscription: { refresh_status: 'failed', checked_at: 200 },
    };
    expect(mergeQuotaWindows(current, stale)).toEqual(current);
    expect(mergeQuotaWindows(current, current)).toEqual(current);
  });

  it.each([
    { refresh_status: 'succeeded', checked_at: 200 },
    { refresh_status: 'failed', checked_at: -1 },
    { refresh_status: 'failed', checked_at: 200, raw_response: 'not-owned' },
    {
      refresh_status: 'succeeded',
      checked_at: 200,
      observation: { status: 'missing', tier: 'pro', source: 'none', observed_at: 200 },
    },
  ])('rejects malformed persisted subscription evidence: %j', (subscription) => {
    expect(CloudQuotaDataSchema.safeParse({ models: {}, subscription }).success).toBe(false);
  });
});
