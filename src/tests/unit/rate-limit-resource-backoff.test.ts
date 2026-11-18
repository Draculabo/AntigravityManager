import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  RateLimitReason,
  RateLimitTrackerService,
} from '@/server/gateway/shared/services/rate-limit-tracker.service';

const now = Date.UTC(2026, 9, 13);
const genericError = {
  status: 429,
  body: JSON.stringify({
    error: { status: 'RESOURCE_EXHAUSTED', message: 'Resource has been exhausted.' },
  }),
  backoffSteps: [60, 300],
};

describe('Account resource-exhausted cooldown', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('escalates across models on one account while leaving other accounts and models available', () => {
    const tracker = new RateLimitTrackerService();
    const first = tracker.parseAndMarkFromError({
      ...genericError,
      accountId: 'account-a',
      model: 'model-x',
    });
    expect(first).toEqual({
      reason: RateLimitReason.RateLimitExceeded,
      upstreamStatus: 429,
      retryAfterSec: 5,
      resetTimeMs: now + 5_000,
      model: 'model-x',
      preservesExplicitQuota: false,
    });
    expect(tracker.getRemainingWaitSeconds('account-a', 'model-y')).toBe(0);
    expect(tracker.getRemainingWaitSeconds('account-b', 'model-x')).toBe(0);

    vi.setSystemTime(now + 5_000);
    const second = tracker.parseAndMarkFromError({
      ...genericError,
      accountId: 'account-a',
      model: 'model-y',
    });
    expect(second).toEqual({
      ...first,
      model: 'model-y',
      retryAfterSec: 15,
      resetTimeMs: now + 20_000,
    });
    expect(tracker.getRemainingWaitSeconds('account-a', 'model-x')).toBe(0);

    vi.setSystemTime(now + 20_000);
    expect(
      tracker.parseAndMarkFromError({ ...genericError, accountId: 'account-a', model: 'model-x' }),
    ).toEqual({ ...first, retryAfterSec: 30, resetTimeMs: now + 50_000 });
    vi.setSystemTime(now + 50_000);
    expect(
      tracker.parseAndMarkFromError({ ...genericError, accountId: 'account-a', model: 'model-x' }),
    ).toEqual({ ...first, retryAfterSec: 30, resetTimeMs: now + 80_000 });
    expect(
      tracker.parseAndMarkFromError({ ...genericError, accountId: 'account-b', model: 'model-x' }),
    ).toEqual({ ...first, resetTimeMs: now + 55_000 });
  });

  it('resets the account escalation on a model success without clearing another model hard quota', () => {
    const tracker = new RateLimitTrackerService();
    tracker.parseAndMarkFromError({ ...genericError, accountId: 'account-a', model: 'model-x' });
    const hardQuota = tracker.parseAndMarkFromError({
      accountId: 'account-a',
      model: 'model-hard',
      status: 429,
      body: 'QUOTA_EXHAUSTED; retry after 3600s',
      backoffSteps: [60, 300],
    });
    tracker.markModelSuccess('account-a', 'model-y');
    vi.setSystemTime(now + 5_000);

    expect(
      tracker.parseAndMarkFromError({ ...genericError, accountId: 'account-a', model: 'model-x' }),
    ).toEqual({
      reason: RateLimitReason.RateLimitExceeded,
      upstreamStatus: 429,
      retryAfterSec: 5,
      resetTimeMs: now + 10_000,
      model: 'model-x',
      preservesExplicitQuota: false,
    });
    expect(hardQuota).toEqual({
      reason: RateLimitReason.QuotaExhausted,
      upstreamStatus: 429,
      retryAfterSec: 3600,
      resetTimeMs: now + 3_600_000,
      model: 'model-hard',
      preservesExplicitQuota: true,
    });
    expect(tracker.getRemainingWaitSeconds('account-a', 'model-hard')).toBe(3595);
  });

  it('expires escalation one hour after the last failure, including the exact boundary', () => {
    const tracker = new RateLimitTrackerService();
    tracker.parseAndMarkFromError({ ...genericError, accountId: 'account-a', model: 'model-x' });
    vi.setSystemTime(now + 5_000);
    expect(
      tracker.parseAndMarkFromError({ ...genericError, accountId: 'account-a', model: 'model-x' })
        ?.retryAfterSec,
    ).toBe(15);
    vi.setSystemTime(now + 3_605_000);
    expect(
      tracker.parseAndMarkFromError({ ...genericError, accountId: 'account-a', model: 'model-x' })
        ?.retryAfterSec,
    ).toBe(5);
  });

  it('does not let server/capacity errors, other rate limits or explicit hints advance the generic staircase', () => {
    const tracker = new RateLimitTrackerService();
    const record = (status: number, body: string, retryAfter?: string) =>
      tracker.parseAndMarkFromError({
        accountId: 'account-a',
        model: 'model-x',
        status,
        body,
        retryAfter,
        backoffSteps: [60, 300],
      });
    expect(record(503, 'Service unavailable')?.retryAfterSec).toBe(8);
    expect(
      record(503, JSON.stringify({ error: { details: [{ reason: 'MODEL_CAPACITY_EXHAUSTED' }] } }))
        ?.retryAfterSec,
    ).toBe(5);
    expect(record(429, 'Too many requests')?.retryAfterSec).toBe(5);
    expect(record(429, genericError.body, '42')?.retryAfterSec).toBe(42);
    expect(record(429, genericError.body)?.retryAfterSec).toBe(5);
    expect(record(429, genericError.body)?.retryAfterSec).toBe(15);
  });

  it('preserves a longer explicit quota when a later generic error is on the same model', () => {
    const tracker = new RateLimitTrackerService();
    const quota = tracker.parseAndMarkFromError({
      accountId: 'account-a',
      model: 'model-x',
      status: 429,
      body: 'QUOTA_EXHAUSTED; retry after 3600s',
      backoffSteps: [60, 300],
    });
    expect(
      tracker.parseAndMarkFromError({ ...genericError, accountId: 'account-a', model: 'model-x' }),
    ).toEqual(quota);
    expect(tracker.getRemainingWaitSeconds('account-a', 'model-x')).toBe(3600);
  });

  it('keeps escalation after transient locks expire and resets it on an explicit tracker reset', () => {
    const tracker = new RateLimitTrackerService();
    tracker.parseAndMarkFromError({ ...genericError, accountId: 'account-a', model: 'model-x' });
    vi.setSystemTime(now + 5_000);
    expect(tracker.cleanupExpired()).toBe(1);
    expect(
      tracker.parseAndMarkFromError({ ...genericError, accountId: 'account-a', model: 'model-x' })
        ?.retryAfterSec,
    ).toBe(15);
    tracker.clearAll();
    expect(
      tracker.parseAndMarkFromError({ ...genericError, accountId: 'account-a', model: 'model-x' })
        ?.retryAfterSec,
    ).toBe(5);
  });
});
