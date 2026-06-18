import { describe, expect, it } from 'vitest';
import {
  parseRetryDelayMilliseconds,
  RateLimitReason,
  RateLimitTracker,
  shouldGraceRetry,
} from '../../modules/proxy-gateway/server/rate-limit-tracker';

describe('RateLimitTracker parity replay', () => {
  it('uses Retry-After header before body/default', () => {
    const tracker = new RateLimitTracker();
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
    expect(tracker.isRateLimited('acc-1')).toBe(true);
  });

  it('uses model-level key for quota exhausted', () => {
    const tracker = new RateLimitTracker();
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
    const tracker = new RateLimitTracker();
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

  it('parses MODEL_CAPACITY_EXHAUSTED and RetryInfo.retryDelay from 503 payload', () => {
    const tracker = new RateLimitTracker();
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
    expect(tracker.isRateLimited('acc-4')).toBe(true);
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
    const tracker = new RateLimitTracker();
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
