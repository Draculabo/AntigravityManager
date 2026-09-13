import { describe, expect, it } from 'vitest';
import { AccountLeaseService } from '@/modules/proxy-gateway/server/modules/account-lease/account-lease.service';
import { RateLimitTrackerService } from '@/modules/proxy-gateway/server/shared/services/rate-limit-tracker.service';
import {
  ModelAvailabilityService,
  type ProxyModelAvailability,
  type ProxyModelAvailabilityPersistence,
} from '@/modules/proxy-gateway/server/shared/services/model-availability.service';

function createAvailability(entries: ProxyModelAvailability[]): ModelAvailabilityService {
  const persistence: ProxyModelAvailabilityPersistence = {
    load: () => structuredClone(entries),
    save: () => {},
  };
  return new ModelAvailabilityService(persistence);
}

describe('AccountLeaseService persisted image limits', () => {
  it('restores only qualified long image quota locks when lease state is reloaded', () => {
    const now = Date.now();
    const tracker = new RateLimitTrackerService();
    const availability = createAvailability([
      {
        accountId: 'acc-long-image',
        modelId: 'gemini-3.1-pro-image',
        reason: 'quota_exhausted',
        unavailableUntil: now + 210_293_000,
        status: 429,
        detectedAt: now,
        message: 'QUOTA_EXHAUSTED; retry after 210293s',
      },
      {
        accountId: 'acc-short-image',
        modelId: 'gemini-3-flash-image',
        reason: 'rate_limited',
        unavailableUntil: now + 210_293_000,
        status: 429,
        detectedAt: now,
        message: 'retry after 210293s',
      },
    ]);
    const service = new AccountLeaseService(undefined, undefined, tracker, availability);
    const resetFromPersistence = service as unknown as {
      resetRateLimitsFromPersistence(): void;
    };

    resetFromPersistence.resetRateLimitsFromPersistence();

    expect(
      tracker.getRemainingWaitSeconds('acc-long-image', 'gemini-3.1-pro-image'),
    ).toBeGreaterThan(300);
    expect(tracker.isRateLimited('acc-short-image', 'gemini-3-flash-image')).toBe(false);
  });
});
