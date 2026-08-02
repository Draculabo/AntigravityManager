import { describe, expect, it, vi } from 'vitest';
import { AccountLeaseLimitPolicy } from '@/modules/proxy-gateway/server/account-lease-limit-policy';
import { RateLimitReason } from '@/modules/proxy-gateway/server/rate-limit-tracker';

function createPolicy() {
  const logger = {
    warn: vi.fn(),
  };
  const refreshRealtimeQuotaAndReconcileLimit = vi.fn().mockResolvedValue('unavailable');
  const setPreciseLockoutFromCachedQuota = vi.fn().mockReturnValue(false);
  const policy = new AccountLeaseLimitPolicy({
    rateLimitCooldownMs: 300_000,
    forbiddenCooldownMs: 1_800_000,
    resolveAccountId: (accountIdOrEmail) =>
      accountIdOrEmail === 'lease@example.com' ? 'acc-1' : null,
    getCircuitBreakerBackoffSteps: () => [60, 300],
    refreshRealtimeQuotaAndReconcileLimit,
    setPreciseLockoutFromCachedQuota,
    logger,
  });

  return {
    logger,
    policy,
    refreshRealtimeQuotaAndReconcileLimit,
    setPreciseLockoutFromCachedQuota,
  };
}

describe('AccountLeaseLimitPolicy', () => {
  it('applies legacy account cooldowns through resolved account ids', () => {
    const { policy } = createPolicy();

    policy.markAsRateLimited('lease@example.com');

    expect(policy.isRateLimited('acc-1')).toBe(true);
  });

  it('routes quota exhaustion without retry hints through precise lockout callbacks', async () => {
    const { policy, refreshRealtimeQuotaAndReconcileLimit, setPreciseLockoutFromCachedQuota } =
      createPolicy();

    refreshRealtimeQuotaAndReconcileLimit.mockResolvedValue('recovered');

    await policy.markFromUpstreamError({
      accountIdOrEmail: 'lease@example.com',
      status: 429,
      model: 'models/gemini-2.5-flash',
      body: 'quota exhausted',
    });

    expect(refreshRealtimeQuotaAndReconcileLimit).toHaveBeenCalledWith(
      'acc-1',
      RateLimitReason.QuotaExhausted,
      'gemini-2.5-flash',
    );
    expect(setPreciseLockoutFromCachedQuota).not.toHaveBeenCalled();
  });

  it('keeps upstream rate limits scoped to the affected model', async () => {
    const { policy, refreshRealtimeQuotaAndReconcileLimit } = createPolicy();

    await policy.markFromUpstreamError({
      accountIdOrEmail: 'acc-1',
      status: 429,
      model: 'gemini-2.5-flash',
      body: JSON.stringify({
        error: {
          details: [{ reason: 'RATE_LIMIT_EXCEEDED' }],
        },
      }),
    });

    expect(refreshRealtimeQuotaAndReconcileLimit).not.toHaveBeenCalled();
    expect(policy.isRateLimited('acc-1', 'gemini-2.5-flash')).toBe(true);
    expect(policy.isRateLimited('acc-1', 'gemini-2.5-pro')).toBe(false);
  });

  it('does not run quota refresh for generic RESOURCE_EXHAUSTED responses', async () => {
    const { policy, refreshRealtimeQuotaAndReconcileLimit } = createPolicy();

    await policy.markFromUpstreamError({
      accountIdOrEmail: 'acc-1',
      status: 429,
      model: 'gemini-3.1-pro-high',
      body: JSON.stringify({
        error: {
          message: 'Resource has been exhausted (e.g. check quota).',
          status: 'RESOURCE_EXHAUSTED',
        },
      }),
    });

    expect(refreshRealtimeQuotaAndReconcileLimit).not.toHaveBeenCalled();
    expect(policy.isRateLimited('acc-1', 'gemini-3.1-pro-high')).toBe(true);
    expect(policy.isRateLimited('acc-1', 'gemini-3.1-flash-lite')).toBe(false);
  });

  it('clears only recovered model families during partial quota recovery', () => {
    const { policy } = createPolicy();
    const resetTime = new Date(Date.now() + 60_000).toISOString();
    const tracker = policy.getRateLimitTracker();
    tracker.setLockoutUntilIso(
      'acc-1',
      resetTime,
      RateLimitReason.QuotaExhausted,
      'gemini-3.1-pro-high',
    );
    tracker.setLockoutUntilIso(
      'acc-1',
      resetTime,
      RateLimitReason.QuotaExhausted,
      'gemini-3.1-flash-lite',
    );

    policy.clearRecoveredQuotaLocks('acc-1', ['gemini-3.1-pro'], false);

    expect(tracker.isRateLimited('acc-1', 'gemini-3.1-pro-high')).toBe(false);
    expect(tracker.isRateLimited('acc-1', 'gemini-3.1-flash-lite')).toBe(true);
  });

  it('clears legacy and tracker account locks only after full account recovery', () => {
    const { policy } = createPolicy();
    const resetTime = new Date(Date.now() + 60_000).toISOString();
    const tracker = policy.getRateLimitTracker();

    policy.markAsRateLimited('acc-1');
    tracker.setLockoutUntilIso('acc-1', resetTime, RateLimitReason.QuotaExhausted);
    policy.clearRecoveredQuotaLocks('acc-1', ['gemini-3.1-pro'], false);
    expect(policy.isRateLimited('acc-1')).toBe(true);

    policy.clearRecoveredQuotaLocks('acc-1', ['gemini-3.1-pro'], true);
    expect(policy.isRateLimited('acc-1')).toBe(false);
  });
});
