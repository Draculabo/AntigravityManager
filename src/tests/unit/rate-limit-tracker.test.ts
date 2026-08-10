import { describe, expect, it } from 'vitest';
import {
  parseRetryDelayMilliseconds,
  RateLimitReason,
  RateLimitTrackerService,
  shouldGraceRetry,
} from '../../modules/proxy-gateway/server/shared/services/rate-limit-tracker.service';

describe('RateLimitTrackerService parity replay', () => {
  it('uses Retry-After header before body/default', () => {
    const tracker = new RateLimitTrackerService();
    const info = tracker.parseAndMarkFromError({
      accountId: 'acc-1',
      status: 429,
      retryAfter: '30',
      body: JSON.stringify({
        error: {
          details: [{ reason: 'RATE_LIMIT_EXCEEDED' }],
          retry_after: 1,
        },
      }),
      model: 'gemini-2.5-pro',
      backoffSteps: [60, 300, 1800, 7200],
    });

    expect(info).not.toBeNull();
    expect(info?.reason).toBe(RateLimitReason.RateLimitExceeded);
    expect(info?.retryAfterSec).toBe(30);
    expect(tracker.isRateLimited('acc-1', 'gemini-2.5-pro')).toBe(true);
    expect(tracker.isRateLimited('acc-1', 'gemini-2.5-flash')).toBe(false);
  });

  it('treats generic RESOURCE_EXHAUSTED as a short model-level rate limit', () => {
    const tracker = new RateLimitTrackerService();
    const info = tracker.parseAndMarkFromError({
      accountId: 'acc-resource',
      status: 429,
      body: JSON.stringify({
        error: {
          code: 429,
          message: 'Resource has been exhausted (e.g. check quota).',
          status: 'RESOURCE_EXHAUSTED',
        },
      }),
      model: 'gemini-3.1-pro-high',
      backoffSteps: [60, 300, 1800, 7200],
    });

    expect(info).toMatchObject({
      reason: RateLimitReason.RateLimitExceeded,
      retryAfterSec: 30,
      model: 'gemini-3.1-pro-high',
    });
    expect(tracker.isRateLimited('acc-resource', 'gemini-3.1-pro-high')).toBe(true);
    expect(tracker.isRateLimited('acc-resource', 'gemini-3.1-flash-lite')).toBe(false);
  });

  it('keeps explicit daily quota failures classified as quota exhausted', () => {
    const tracker = new RateLimitTrackerService();
    const info = tracker.parseAndMarkFromError({
      accountId: 'acc-daily',
      status: 429,
      body: JSON.stringify({
        error: {
          message: 'Resource exhausted: daily quota limit reached; quota will reset tomorrow.',
          status: 'RESOURCE_EXHAUSTED',
        },
      }),
      model: 'gemini-3.1-pro-high',
      backoffSteps: [60, 300, 1800, 7200],
    });

    expect(info?.reason).toBe(RateLimitReason.QuotaExhausted);
    expect(info?.retryAfterSec).toBe(60);
  });

  it('clears only the successful model lockout', () => {
    const tracker = new RateLimitTrackerService();
    const commonError = {
      status: 429,
      body: 'Resource has been exhausted.',
      backoffSteps: [60, 300, 1800, 7200],
    };

    tracker.parseAndMarkFromError({
      ...commonError,
      accountId: 'acc-success',
      model: 'gemini-3.1-pro-high',
    });
    tracker.parseAndMarkFromError({
      ...commonError,
      accountId: 'acc-success',
      model: 'gemini-3.1-flash-lite',
    });

    tracker.markModelSuccess('acc-success', 'gemini-3.1-pro-high');

    expect(tracker.isRateLimited('acc-success', 'gemini-3.1-pro-high')).toBe(false);
    expect(tracker.isRateLimited('acc-success', 'gemini-3.1-flash-lite')).toBe(true);
  });

  it('clears recovered model aliases without clearing another model family', () => {
    const tracker = new RateLimitTrackerService();
    const resetTime = new Date(Date.now() + 60_000).toISOString();

    tracker.setLockoutUntilIso(
      'acc-recovered',
      resetTime,
      RateLimitReason.QuotaExhausted,
      'gemini-3.1-pro-high',
    );
    tracker.setLockoutUntilIso(
      'acc-recovered',
      resetTime,
      RateLimitReason.QuotaExhausted,
      'gemini-3.1-flash-lite',
    );

    expect(tracker.clearModelFamilies('acc-recovered', ['gemini-3.1-pro'])).toBe(1);
    expect(tracker.isRateLimited('acc-recovered', 'gemini-3.1-pro-high')).toBe(false);
    expect(tracker.isRateLimited('acc-recovered', 'gemini-3.1-flash-lite')).toBe(true);
  });

  it('uses model-level key for quota exhausted', () => {
    const tracker = new RateLimitTrackerService();
    tracker.parseAndMarkFromError({
      accountId: 'acc-2',
      status: 429,
      body: JSON.stringify({
        error: {
          details: [
            {
              reason: 'QUOTA_EXHAUSTED',
              metadata: { quotaResetDelay: '42s' },
            },
          ],
        },
      }),
      model: 'gemini-2.5-flash',
      backoffSteps: [60, 300, 1800, 7200],
    });

    expect(tracker.isRateLimited('acc-2', 'gemini-2.5-flash')).toBe(true);
    expect(tracker.isRateLimited('acc-2', 'gemini-2.5-pro')).toBe(false);
  });

  it('uses backoff steps when no header/body retry hint', () => {
    const tracker = new RateLimitTrackerService();
    const steps = [60, 300, 1800, 7200];

    const first = tracker.parseAndMarkFromError({
      accountId: 'acc-3',
      status: 429,
      body: JSON.stringify({
        error: { details: [{ reason: 'QUOTA_EXHAUSTED' }] },
      }),
      backoffSteps: steps,
    });
    const second = tracker.parseAndMarkFromError({
      accountId: 'acc-3',
      status: 429,
      body: JSON.stringify({
        error: { details: [{ reason: 'QUOTA_EXHAUSTED' }] },
      }),
      backoffSteps: steps,
    });

    expect(first?.retryAfterSec).toBe(60);
    expect(second?.retryAfterSec).toBe(300);
  });

  it('caps upstream and precise quota lockouts at five minutes', () => {
    const tracker = new RateLimitTrackerService();
    const info = tracker.parseAndMarkFromError({
      accountId: 'acc-long-retry',
      status: 429,
      retryAfter: '3600',
      body: 'quota limit reached',
      model: 'gemini-3.1-pro-high',
      backoffSteps: [60, 300, 1800, 7200],
    });

    expect(info?.retryAfterSec).toBe(300);
    expect(
      tracker.getRemainingWaitSeconds('acc-long-retry', 'gemini-3.1-pro-high'),
    ).toBeLessThanOrEqual(300);

    tracker.setLockoutUntilIso(
      'acc-precise-reset',
      new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      RateLimitReason.QuotaExhausted,
      'gemini-3.1-pro-high',
    );

    expect(
      tracker.getRemainingWaitSeconds('acc-precise-reset', 'gemini-3.1-pro-high'),
    ).toBeLessThanOrEqual(300);
  });

  it('parses MODEL_CAPACITY_EXHAUSTED and RetryInfo.retryDelay from 503 payload', () => {
    const tracker = new RateLimitTrackerService();
    const info = tracker.parseAndMarkFromError({
      accountId: 'acc-4',
      status: 503,
      model: 'gemini-3.1-pro-high',
      body: JSON.stringify({
        error: {
          code: 503,
          message: 'No capacity available for model gemini-3.1-pro-high on the server',
          status: 'UNAVAILABLE',
          details: [
            {
              '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
              reason: 'MODEL_CAPACITY_EXHAUSTED',
              domain: 'cloudcode-pa.googleapis.com',
              metadata: { model: 'gemini-3.1-pro-high' },
            },
            {
              '@type': 'type.googleapis.com/google.rpc.RetryInfo',
              retryDelay: '30s',
            },
          ],
        },
      }),
      backoffSteps: [60, 300, 1800, 7200],
    });

    expect(info).not.toBeNull();
    expect(info?.reason).toBe(RateLimitReason.ModelCapacityExhausted);
    expect(info?.retryAfterSec).toBe(32);
    expect(tracker.isRateLimited('acc-4', 'gemini-3.1-pro-high')).toBe(true);
    expect(tracker.isRateLimited('acc-4', 'gemini-3.1-flash-lite')).toBe(false);
  });

  it('parses short retry hints for same-account grace retry', () => {
    const retryDelayMs = parseRetryDelayMilliseconds(
      JSON.stringify({
        error: {
          details: [
            {
              metadata: {
                quotaResetDelay: '200ms',
              },
            },
          ],
        },
      }),
    );

    expect(retryDelayMs).toBe(200);
    expect(shouldGraceRetry(retryDelayMs ?? 0)).toBe(true);
    expect(parseRetryDelayMilliseconds('retry after 1s')).toBe(1000);
    expect(shouldGraceRetry(parseRetryDelayMilliseconds('retry after 1s') ?? 0)).toBe(true);
  });

  it('does not let server errors advance quota exhausted backoff', () => {
    const tracker = new RateLimitTrackerService();
    const backoffSteps = [60, 300, 1800, 7200];

    for (let i = 0; i < 3; i += 1) {
      const serverError = tracker.parseAndMarkFromError({
        accountId: 'acc-5',
        status: 503,
        body: 'Service Unavailable',
        backoffSteps,
      });

      expect(serverError?.reason).toBe(RateLimitReason.ServerError);
      expect(serverError?.retryAfterSec).toBe(8);
    }

    const quotaError = tracker.parseAndMarkFromError({
      accountId: 'acc-5',
      status: 429,
      body: JSON.stringify({
        error: {
          details: [{ reason: 'QUOTA_EXHAUSTED' }],
        },
      }),
      backoffSteps,
    });

    expect(quotaError?.reason).toBe(RateLimitReason.QuotaExhausted);
    expect(quotaError?.retryAfterSec).toBe(60);
  });
});
