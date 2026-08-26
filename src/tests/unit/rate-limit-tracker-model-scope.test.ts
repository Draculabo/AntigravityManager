import { describe, expect, it } from 'vitest';
import {
  RateLimitReason,
  RateLimitTrackerService,
} from '../../modules/proxy-gateway/server/shared/services/rate-limit-tracker.service';

const backoffSteps = [10, 20, 40, 80];

function quotaError(accountId: string, model: string) {
  return {
    accountId,
    status: 429,
    body: JSON.stringify({
      error: {
        details: [{ reason: 'QUOTA_EXHAUSTED' }],
      },
    }),
    model,
    backoffSteps,
  };
}

function capacityError(accountId: string, model: string) {
  return {
    accountId,
    status: 503,
    body: JSON.stringify({
      error: {
        status: 'UNAVAILABLE',
        details: [{ reason: 'MODEL_CAPACITY_EXHAUSTED' }],
      },
    }),
    model,
    backoffSteps,
  };
}

describe('RateLimitTrackerService model-scoped backoff', () => {
  it('does not let one model advance another model quota backoff', () => {
    const tracker = new RateLimitTrackerService();

    const modelAFirst = tracker.parseAndMarkFromError(quotaError('acc-model-scope', 'model-a'));
    const modelBFirst = tracker.parseAndMarkFromError(quotaError('acc-model-scope', 'model-b'));
    const modelASecond = tracker.parseAndMarkFromError(quotaError('acc-model-scope', 'model-a'));

    expect(modelAFirst).toMatchObject({
      reason: RateLimitReason.QuotaExhausted,
      retryAfterSec: 10,
    });
    expect(modelBFirst).toMatchObject({
      reason: RateLimitReason.QuotaExhausted,
      retryAfterSec: 10,
    });
    expect(modelASecond).toMatchObject({
      reason: RateLimitReason.QuotaExhausted,
      retryAfterSec: 20,
    });
  });

  it('keeps another model backoff history when one model succeeds', () => {
    const tracker = new RateLimitTrackerService();

    tracker.parseAndMarkFromError(quotaError('acc-success-scope', 'model-a'));
    tracker.parseAndMarkFromError(quotaError('acc-success-scope', 'model-b'));
    tracker.parseAndMarkFromError(quotaError('acc-success-scope', 'model-b'));

    tracker.markModelSuccess('acc-success-scope', 'model-a');

    const modelANext = tracker.parseAndMarkFromError(quotaError('acc-success-scope', 'model-a'));
    const modelBNext = tracker.parseAndMarkFromError(quotaError('acc-success-scope', 'model-b'));

    expect(modelANext?.retryAfterSec).toBe(10);
    expect(modelBNext?.retryAfterSec).toBe(40);
  });

  it('keeps model capacity escalation independent between models', () => {
    const tracker = new RateLimitTrackerService();

    const modelAFirst = tracker.parseAndMarkFromError(
      capacityError('acc-capacity-scope', 'model-a'),
    );
    const modelBFirst = tracker.parseAndMarkFromError(
      capacityError('acc-capacity-scope', 'model-b'),
    );
    const modelASecond = tracker.parseAndMarkFromError(
      capacityError('acc-capacity-scope', 'model-a'),
    );

    expect(modelAFirst?.retryAfterSec).toBe(5);
    expect(modelBFirst?.retryAfterSec).toBe(5);
    expect(modelASecond?.retryAfterSec).toBe(10);
  });
});
