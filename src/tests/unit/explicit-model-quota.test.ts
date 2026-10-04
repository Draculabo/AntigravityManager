import { describe, expect, it } from 'vitest';
import {
  RateLimitReason,
  RateLimitTrackerService,
} from '@/modules/proxy-gateway/server/shared/services/rate-limit-tracker.service';

const resetSeconds = 520_035;
const quotaError = JSON.stringify({
  error: {
    status: 'RESOURCE_EXHAUSTED',
    details: [{ reason: 'QUOTA_EXHAUSTED', metadata: { quotaResetDelay: `${resetSeconds}s` } }],
  },
});

describe('explicit model quota deadlines', () => {
  it.each(['claude-sonnet-4-6-thinking', 'gemini-pro-agent', 'gemini-3.7-flash-tiered'])(
    'retains the upstream deadline for %s without blocking another model',
    (model) => {
      const tracker = new RateLimitTrackerService();
      tracker.trackFromUpstreamError({
        accountId: 'account',
        status: 429,
        model,
        body: quotaError,
        backoffSteps: [60, 300],
      });
      expect(tracker.getRemainingWaitSeconds('account', model)).toBe(resetSeconds);
      expect(tracker.getRemainingWaitSeconds('account', 'gemini-3.1-flash-lite')).toBe(0);
      expect(tracker.clearModelFamilies('account', [model])).toBe(0);
      tracker.markModelSuccess('account', model);
      expect(tracker.getRemainingWaitSeconds('account', model)).toBe(0);
    },
  );

  it('does not shorten a quota deadline after a transient failure or global cooldown', () => {
    const tracker = new RateLimitTrackerService();
    const model = 'claude-sonnet-4-6-thinking';
    tracker.trackFromUpstreamError({
      accountId: 'account',
      status: 429,
      model,
      body: quotaError,
      backoffSteps: [60, 300],
    });
    tracker.trackFromUpstreamError({
      accountId: 'account',
      status: 429,
      model,
      body: 'RESOURCE_EXHAUSTED',
      backoffSteps: [60, 300],
    });
    tracker.trackFromUpstreamError({
      accountId: 'account',
      status: 503,
      body: 'unavailable',
      backoffSteps: [60, 300],
    });
    expect(tracker.getRemainingWaitSeconds('account', model)).toBe(resetSeconds);
  });

  it('keeps an explicit exhausted-quota reset while capping transient deadlines', () => {
    const tracker = new RateLimitTrackerService();
    const reset = new Date(Date.now() + resetSeconds * 1000).toISOString();
    tracker.setLockoutUntilIso('quota', reset, RateLimitReason.QuotaExhausted, 'gemini-pro-agent');
    tracker.setLockoutUntilIso(
      'transient',
      reset,
      RateLimitReason.RateLimitExceeded,
      'gemini-pro-agent',
    );
    expect(tracker.getRemainingWaitSeconds('quota', 'gemini-pro-agent')).toBe(resetSeconds);
    expect(tracker.getRemainingWaitSeconds('transient', 'gemini-pro-agent')).toBe(300);
  });
});
