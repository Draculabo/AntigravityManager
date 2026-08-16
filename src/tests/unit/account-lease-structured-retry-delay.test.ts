import { describe, expect, it, vi } from 'vitest';
import { AccountLeaseLimitPolicy } from '@/modules/proxy-gateway/server/modules/account-lease/policies/account-lease-limit.policy';

describe('AccountLeaseLimitPolicy structured retry delays', () => {
  it('honors an upstream retryDelay without replacing it with a quota refresh decision', async () => {
    const refreshRealtimeQuotaAndReconcileLimit = vi.fn(async () => 'recovered' as const);
    const setPreciseLockoutFromCachedQuota = vi.fn(() => false);
    const logger = { warn: vi.fn() };
    const policy = new AccountLeaseLimitPolicy({
      rateLimitCooldownMs: 60_000,
      forbiddenCooldownMs: 60_000,
      resolveAccountId: (value) => value,
      getCircuitBreakerBackoffSteps: () => [60, 300, 1800],
      refreshRealtimeQuotaAndReconcileLimit,
      setPreciseLockoutFromCachedQuota,
      logger,
    });

    await policy.markFromUpstreamError({
      accountIdOrEmail: 'acc-1',
      status: 429,
      model: 'models/gemini-3.1-pro',
      body: JSON.stringify({
        error: {
          status: 'RESOURCE_EXHAUSTED',
          details: [
            {
              '@type': 'type.googleapis.com/google.rpc.RetryInfo',
              retryDelay: '12s',
            },
          ],
        },
      }),
    });

    expect(refreshRealtimeQuotaAndReconcileLimit).not.toHaveBeenCalled();
    expect(setPreciseLockoutFromCachedQuota).not.toHaveBeenCalled();
    expect(policy.isRateLimited('acc-1', 'gemini-3.1-pro')).toBe(true);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Recorded upstream limit for account acc-1'),
    );
  });
});
