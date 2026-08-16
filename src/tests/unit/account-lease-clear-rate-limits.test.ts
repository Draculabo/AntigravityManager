import { describe, expect, it, vi } from 'vitest';
import { AccountLeaseLimitPolicy } from '@/modules/proxy-gateway/server/modules/account-lease/policies/account-lease-limit.policy';

function createPolicy() {
  return new AccountLeaseLimitPolicy({
    rateLimitCooldownMs: 300_000,
    forbiddenCooldownMs: 1_800_000,
    resolveAccountId: (accountIdOrEmail) => accountIdOrEmail,
    getCircuitBreakerBackoffSteps: () => [60, 300],
    refreshRealtimeQuotaAndReconcileLimit: vi.fn().mockResolvedValue('unavailable'),
    setPreciseLockoutFromCachedQuota: vi.fn().mockReturnValue(false),
    logger: { warn: vi.fn() },
  });
}

describe('AccountLeaseLimitPolicy rate-limit reset', () => {
  it('clears backoff history together with active rate-limit state', () => {
    const policy = createPolicy();
    const tracker = policy.getRateLimitTracker();
    const error = {
      accountId: 'acc-reset',
      status: 429,
      body: JSON.stringify({
        error: { details: [{ reason: 'QUOTA_EXHAUSTED' }] },
      }),
      backoffSteps: [60, 300],
    };

    expect(tracker.trackFromUpstreamError(error)?.retryAfterSec).toBe(60);
    expect(tracker.trackFromUpstreamError(error)?.retryAfterSec).toBe(300);

    policy.markAsRateLimited('acc-reset');
    expect(policy.isRateLimited('acc-reset')).toBe(true);

    policy.clearAllRateLimits();

    expect(policy.isRateLimited('acc-reset')).toBe(false);
    expect(policy.getRateLimitTracker()).not.toBe(tracker);
    expect(policy.getRateLimitTracker().trackFromUpstreamError(error)?.retryAfterSec).toBe(60);
  });
});
