import { describe, expect, it, vi } from 'vitest';
import { AccountLeaseLimitPolicy } from '@/server/gateway/modules/account-lease/policies/account-lease-limit.policy';
import {
  RateLimitReason,
  RateLimitTrackerService,
} from '@/server/gateway/shared/services/rate-limit-tracker.service';

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
    rateLimitTracker: new RateLimitTrackerService(),
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
      model: 'gemini-3.1-pro-low',
      body: JSON.stringify({
        error: {
          message: 'Resource has been exhausted (e.g. check quota).',
          status: 'RESOURCE_EXHAUSTED',
        },
      }),
    });

    expect(refreshRealtimeQuotaAndReconcileLimit).not.toHaveBeenCalled();
    expect(policy.isRateLimited('acc-1', 'gemini-3.1-pro-low')).toBe(true);
    expect(policy.isRateLimited('acc-1', 'gemini-3.1-flash-lite')).toBe(false);
  });

  it('uses the resolved account for resource escalation and resets it without clearing another quota', async () => {
    const { policy, refreshRealtimeQuotaAndReconcileLimit } = createPolicy();
    const tracker = policy.getRateLimitTracker();
    const hardReset = Date.now() + 3_600_000;
    tracker.setLockoutUntilIso(
      'acc-1',
      new Date(hardReset).toISOString(),
      RateLimitReason.QuotaExhausted,
      'model-hard',
    );
    const resource = {
      status: 429,
      body: 'RESOURCE_EXHAUSTED: Resource has been exhausted.',
    };
    await policy.markFromUpstreamError({
      ...resource,
      accountIdOrEmail: 'lease@example.com',
      model: 'model-x',
    });
    expect(tracker.getRemainingWaitSeconds('acc-1', 'model-x')).toBe(5);
    expect(tracker.getRemainingWaitSeconds('acc-1', 'model-y')).toBe(0);
    await policy.markFromUpstreamError({
      ...resource,
      accountIdOrEmail: 'acc-1',
      model: 'model-y',
    });
    expect(tracker.getRemainingWaitSeconds('acc-1', 'model-y')).toBe(15);

    policy.markModelSuccess('lease@example.com', 'model-y');
    await policy.markFromUpstreamError({
      ...resource,
      accountIdOrEmail: 'acc-1',
      model: 'model-y',
    });
    expect(tracker.getRemainingWaitSeconds('acc-1', 'model-y')).toBe(5);
    expect(tracker.getRemainingWaitSeconds('acc-1', 'model-hard')).toBe(3600);
    expect(refreshRealtimeQuotaAndReconcileLimit).not.toHaveBeenCalled();
  });

  it('clears a transient account-level 429 only after a real model success', async () => {
    const { policy } = createPolicy();

    await policy.markFromUpstreamError({
      accountIdOrEmail: 'acc-1',
      status: 429,
      model: 'gemini-3-pro-image',
      body: JSON.stringify({ error: { details: [{ retryDelay: '1s' }] } }),
    });
    expect(policy.isRateLimited('acc-1', 'gemini-3-pro-image')).toBe(true);

    policy.markModelSuccess('acc-1', 'gemini-3-pro-image');

    expect(policy.isRateLimited('acc-1', 'gemini-3-pro-image')).toBe(false);
  });

  it('does not clear an explicit forbidden cooldown on model success', () => {
    const { policy } = createPolicy();
    policy.markAsForbidden('acc-1');

    policy.markModelSuccess('acc-1', 'gemini-3-pro-image');

    expect(policy.isRateLimited('acc-1', 'gemini-3-pro-image')).toBe(true);
  });

  it('clears only recovered model families during partial quota recovery', () => {
    const { policy } = createPolicy();
    const resetTime = new Date(Date.now() + 60_000).toISOString();
    const tracker = policy.getRateLimitTracker();
    tracker.setLockoutUntilIso(
      'acc-1',
      resetTime,
      RateLimitReason.QuotaExhausted,
      'gemini-3.1-pro-low',
    );
    tracker.setLockoutUntilIso(
      'acc-1',
      resetTime,
      RateLimitReason.QuotaExhausted,
      'gemini-3.1-flash-lite',
    );

    policy.clearRecoveredQuotaLocks('acc-1', ['gemini-3.1-pro'], false);

    expect(tracker.isRateLimited('acc-1', 'gemini-3.1-pro-low')).toBe(false);
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
