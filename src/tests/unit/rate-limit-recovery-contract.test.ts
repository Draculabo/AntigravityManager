import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountLeaseLimitPolicy } from '@/server/gateway/modules/account-lease/policies/account-lease-limit.policy';
import {
  RateLimitReason,
  RateLimitTrackerService,
} from '@/server/gateway/shared/services/rate-limit-tracker.service';
import { ModelAvailabilityService } from '@/server/gateway/shared/services/model-availability.service';

const now = Date.parse('2026-10-16T00:00:00Z');
const model = 'claude-sonnet-4-6-thinking';
function fixture() {
  const tracker = new RateLimitTrackerService();
  const refresh = vi.fn().mockResolvedValue('unavailable');
  const cached = vi.fn().mockReturnValue(false);
  const logger = { warn: vi.fn() };
  const policy = new AccountLeaseLimitPolicy({
    rateLimitCooldownMs: 300_000,
    forbiddenCooldownMs: 1_800_000,
    resolveAccountId: (id) => (id === 'synthetic@example.test' ? 'account' : null),
    getCircuitBreakerBackoffSteps: () => [60, 300],
    refreshRealtimeQuotaAndReconcileLimit: refresh,
    setPreciseLockoutFromCachedQuota: cached,
    logger,
    rateLimitTracker: tracker,
  });
  const fail = (body: string, retryAfter?: string) =>
    policy.markFromUpstreamError({
      accountIdOrEmail: 'synthetic@example.test',
      model,
      status: 429,
      body,
      retryAfter,
    });
  return { tracker, policy, refresh, cached, logger, fail };
}
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(now);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('D01 recovery evidence and scoped success', () => {
  it('redacts an unresolved email in limit diagnostics without changing account-ID resolution', async () => {
    const { policy, logger } = fixture();
    policy.markAsRateLimited('missing@example.test');
    await policy.markFromUpstreamError({
      accountIdOrEmail: 'missing@example.test',
      status: 429,
      model,
      retryAfter: '5',
      body: 'RESOURCE_EXHAUSTED',
    });
    const messages = logger.warn.mock.calls.map(([message]) => message).join('\n');
    expect(messages).toContain('[unresolved]');
    expect(messages).not.toContain('missing@example.test');
  });
  it.each(['MODEL_CAPACITY_EXHAUSTED', 'model capacity exhausted'])(
    'keeps a bare capacity marker out of quota reconciliation: %s',
    async (body) => {
      const { fail, refresh, tracker } = fixture();
      await fail(body);
      expect(refresh).not.toHaveBeenCalled();
      expect(tracker.getRemainingWaitSeconds('account', model)).toBe(5);
      expect(tracker.getRemainingWaitSeconds('account', 'gemini-pro-agent')).toBe(0);
    },
  );
  it.each([6_900_000, 7_050_000])(
    'keeps hard evidence separate from an overlapping temporary lock at %i ms',
    (elapsed) => {
      const { tracker } = fixture();
      tracker.setLockoutUntilIso(
        'account',
        new Date(now + 7_200_000).toISOString(),
        RateLimitReason.QuotaExhausted,
        model,
      );
      vi.setSystemTime(now + elapsed);
      tracker.trackFromUpstreamError({
        accountId: 'account',
        model,
        status: 429,
        retryAfter: '300',
        body: 'RESOURCE_EXHAUSTED',
        backoffSteps: [60, 300],
      });
      expect(tracker.getRemainingWaitSeconds('account', model)).toBe(300);
      expect(tracker.hasActiveQuotaLock('account', model)).toBe(true);
      expect(tracker.clearModelFamilies('account', [model])).toBe(0);
      vi.setSystemTime(now + 7_200_001);
      expect(tracker.hasActiveQuotaLock('account', model)).toBe(false);
      if (elapsed === 7_050_000) {
        expect(tracker.getRemainingWaitSeconds('account', model)).toBe(150);
      }
    },
  );

  it('keeps qualified durable evidence during the final transient-sized part of its deadline', () => {
    const saves = vi.fn();
    const availability = new ModelAvailabilityService({ load: () => [], save: saves });
    availability.mark('account', model, 'quota_exhausted', now + 7_200_000, {
      status: 429,
      message: 'QUOTA_EXHAUSTED retry after 7200s',
    });
    const original = availability.getActiveSnapshot();
    vi.setSystemTime(now + 7_050_000);
    availability.mark('account', model, 'rate_limited', Date.now() + 300_000, {
      status: 429,
      message: 'retry after 300s\nRESOURCE_EXHAUSTED',
    });
    expect(availability.getActiveSnapshot()).toEqual(original);
    expect(saves).toHaveBeenCalledOnce();
    const restarted = new ModelAvailabilityService({ load: () => original, save: vi.fn() });
    const tracker = new RateLimitTrackerService();
    expect(tracker.restorePersistedQuotaLimit(restarted.getActiveSnapshot()[0])).toBe(true);
    expect(tracker.getRemainingWaitSeconds('account', model)).toBe(150);
  });
  it.each([
    'RESOURCE_EXHAUSTED: weekly quota exhausted',
    'RESOURCE_EXHAUSTED: per week quota exhausted',
    'RESOURCE_EXHAUSTED: credits exhausted',
    'RESOURCE_EXHAUSTED: insufficient credits',
  ])('reconciles explicit durable quota evidence: %s', async (body) => {
    const { fail, refresh, cached, tracker } = fixture();
    await fail(body);
    expect(refresh).toHaveBeenCalledExactlyOnceWith(
      'account',
      RateLimitReason.QuotaExhausted,
      model,
      undefined,
    );
    expect(cached).toHaveBeenCalledExactlyOnceWith(
      'account',
      RateLimitReason.QuotaExhausted,
      model,
    );
    const parsed = tracker.trackFromUpstreamError({
      accountId: 'direct',
      status: 429,
      body,
      model,
      backoffSteps: [60, 300],
    });
    expect(parsed).toMatchObject({
      reason: RateLimitReason.QuotaExhausted,
      retryAfterSec: 60,
      preservesExplicitQuota: false,
    });
  });

  it.each(['RATE_LIMIT_EXCEEDED', 'MODEL_CAPACITY_EXHAUSTED'])(
    'lets the structured reason take precedence over incidental quota words: %s',
    async (reason) => {
      const { fail, refresh, cached } = fixture();
      await fail(JSON.stringify({ error: { message: 'check quota', details: [{ reason }] } }));
      expect(refresh).not.toHaveBeenCalled();
      expect(cached).not.toHaveBeenCalled();
    },
  );

  it.each(['not-a-delay', '0', '-1', new Date(now - 1_000).toUTCString()])(
    'does not let invalid Retry-After %j suppress quota reconciliation',
    async (retryAfter) => {
      const { fail, refresh, cached } = fixture();
      await fail(
        JSON.stringify({ error: { details: [{ reason: 'QUOTA_EXHAUSTED' }] } }),
        retryAfter,
      );
      expect(refresh).toHaveBeenCalledOnce();
      expect(cached).toHaveBeenCalledOnce();
    },
  );

  it('accepts a valid body hint when the header is invalid', async () => {
    const { fail, refresh, tracker } = fixture();
    await fail(
      JSON.stringify({ error: { details: [{ reason: 'QUOTA_EXHAUSTED', retryDelay: '7200s' }] } }),
      'invalid',
    );
    expect(refresh).not.toHaveBeenCalled();
    expect(tracker.getRemainingWaitSeconds('account', model)).toBe(7200);
  });

  it('retains Retry-After precedence over body hints and does not infer a long deadline', async () => {
    const { fail, tracker } = fixture();
    await fail(
      JSON.stringify({ error: { details: [{ reason: 'QUOTA_EXHAUSTED', retryDelay: '7200s' }] } }),
      '10',
    );
    expect(tracker.getRemainingWaitSeconds('account', model)).toBe(10);
  });

  it.each([0, -1, -86_400_000])('rejects a non-future official reset at offset %i', (offset) => {
    const { tracker } = fixture();
    expect(
      tracker.setLockoutUntilIso(
        'account',
        new Date(now + offset).toISOString(),
        RateLimitReason.QuotaExhausted,
        model,
      ),
    ).toBe(false);
    expect(tracker.getRemainingWaitSeconds('account', model)).toBe(0);
  });

  it('does not replace an active reset with an expired observation', () => {
    const { tracker } = fixture();
    tracker.setLockoutUntilIso(
      'account',
      new Date(now + 86_400_000).toISOString(),
      RateLimitReason.QuotaExhausted,
      model,
    );
    expect(
      tracker.setLockoutUntilIso(
        'account',
        new Date(now - 1).toISOString(),
        RateLimitReason.QuotaExhausted,
        model,
      ),
    ).toBe(false);
    expect(tracker.getRemainingWaitSeconds('account', model)).toBe(86_400);
  });

  it.each(['gemini-pro-agent', 'gemini-3.1-pro-image'])(
    'resets account escalation and only its own temporary lock after success on %s',
    async (successfulModel) => {
      const { policy, tracker, logger } = fixture();
      tracker.setLockoutUntilIso(
        'account',
        new Date(now + 3 * 86_400_000).toISOString(),
        RateLimitReason.QuotaExhausted,
        model,
      );
      await policy.markFromUpstreamError({
        accountIdOrEmail: 'synthetic@example.test',
        status: 429,
        model: successfulModel,
        body: 'RESOURCE_EXHAUSTED',
      });
      policy.markModelSuccess('synthetic@example.test', successfulModel);
      expect(tracker.getRemainingWaitSeconds('account', successfulModel)).toBe(0);
      expect(tracker.getRemainingWaitSeconds('account', model)).toBe(259_200);
      await policy.markFromUpstreamError({
        accountIdOrEmail: 'account',
        status: 429,
        model: successfulModel,
        body: 'RESOURCE_EXHAUSTED',
      });
      expect(tracker.getRemainingWaitSeconds('account', successfulModel)).toBe(5);
      expect(
        logger.warn.mock.calls
          .flatMap((call) => call.filter((value) => typeof value === 'string'))
          .join('\n'),
      ).not.toContain('synthetic@example.test');
    },
  );

  it('preserves the established same-model-success release and deadline expiry rules', () => {
    const { tracker, policy } = fixture();
    tracker.setLockoutUntilIso(
      'account',
      new Date(now + 3_600_000).toISOString(),
      RateLimitReason.QuotaExhausted,
      model,
    );
    policy.markModelSuccess('synthetic@example.test', model);
    expect(tracker.getRemainingWaitSeconds('account', model)).toBe(0);
    tracker.setLockoutUntilIso(
      'account',
      new Date(now + 3_600_000).toISOString(),
      RateLimitReason.QuotaExhausted,
      model,
    );
    vi.setSystemTime(now + 3_600_000);
    expect(tracker.getRemainingWaitSeconds('account', model)).toBe(0);
  });
});
