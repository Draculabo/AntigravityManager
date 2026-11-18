import { expect, it } from 'vitest';
import {
  RateLimitReason,
  RateLimitTrackerService,
} from '@/server/gateway/shared/services/rate-limit-tracker.service';

it('resets only the deleted account global/model locks and both escalation counters', () => {
  const tracker = new RateLimitTrackerService();
  const resourceFailure = (accountId: string) =>
    tracker.trackFromUpstreamError({
      accountId,
      status: 429,
      model: 'gemini-3-pro',
      body: 'RESOURCE_EXHAUSTED: Resource has been exhausted.',
      backoffSteps: [2, 4, 8],
    });
  const quotaFailure = (accountId: string) =>
    tracker.trackFromUpstreamError({
      accountId,
      status: 429,
      model: 'claude-opus',
      body: 'quota exhausted',
      backoffSteps: [2, 4, 8],
    });
  for (const accountId of ['a', 'ab']) {
    expect(resourceFailure(accountId)?.retryAfterSec).toBe(5);
    expect(quotaFailure(accountId)?.retryAfterSec).toBe(2);
    tracker.trackFromUpstreamError({ accountId, status: 503, backoffSteps: [] });
    tracker.setLockoutUntilIso(
      accountId,
      new Date(Date.now() + 3_600_000).toISOString(),
      RateLimitReason.QuotaExhausted,
      'claude-sonnet',
    );
  }
  tracker.clearAccount('a');
  expect(tracker.getRemainingWaitSeconds('a', 'gemini-3-pro')).toBe(0);
  expect(tracker.hasActiveQuotaLock('a', 'claude-sonnet')).toBe(false);
  expect(tracker.hasActiveQuotaLock('ab', 'claude-sonnet')).toBe(true);
  expect(resourceFailure('a')?.retryAfterSec).toBe(5);
  expect(resourceFailure('ab')?.retryAfterSec).toBe(15);
  expect(quotaFailure('a')?.retryAfterSec).toBe(2);
  expect(quotaFailure('ab')?.retryAfterSec).toBe(4);
});
