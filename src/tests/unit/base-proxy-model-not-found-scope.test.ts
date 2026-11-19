import { describe, expect, it, vi } from 'vitest';
import { BaseProxyService } from '@/server/gateway/common/base-proxy.service';
import { UpstreamRequestError } from '@/server/gateway/common/exceptions/upstream-request.exception';
import type { AccountLeaseService } from '@/server/gateway/modules/account-lease/account-lease.service';
import type { GeminiClient } from '@/server/gateway/modules/gemini/gemini-client.service';
import type { GenerationConstraintsService } from '@/server/gateway/shared/services/generation-constraints.service';
import { ModelAvailabilityService } from '@/server/gateway/shared/services/model-availability.service';
import type { ModelRoutingService } from '@/server/gateway/shared/services/model-routing.service';
import { ProxyRetryService } from '@/server/gateway/shared/services/proxy-retry.service';
import { createAccount } from './proxy-real-path.harness';

class TestProxyService extends BaseProxyService {
  applyPenalty(accountId: string, model: string, error: unknown): Promise<void> {
    return this.applyUpstreamPenalty(createAccount(accountId), model, error);
  }
}

function createService() {
  const accountLeaseService = {
    isLeaseCurrent: vi.fn(() => true),
    isLeaseEligible: vi.fn(() => true),
    acceptLeaseCompletion: vi.fn(() => true),
    getNextToken: vi.fn(),
    markFromUpstreamError: vi.fn().mockResolvedValue(undefined),
    recordParityError: vi.fn(),
    markAsForbidden: vi.fn(),
    markAsRateLimited: vi.fn(),
    getRemainingRateLimitWait: vi.fn(),
    markModelSuccess: vi.fn(),
  } as unknown as AccountLeaseService;
  const modelAvailability = new ModelAvailabilityService();
  const retryPolicy = new ProxyRetryService(
    accountLeaseService,
    { log: vi.fn(), warn: vi.fn() },
    modelAvailability,
  );

  return {
    accountLeaseService,
    modelAvailability,
    service: new TestProxyService(
      accountLeaseService,
      {} as GeminiClient,
      {} as GenerationConstraintsService,
      retryPolicy,
      {} as ModelRoutingService,
    ),
  };
}

const imageModel = 'gemini-3-pro-image';

describe('BaseProxyService model-not-found penalty scope', () => {
  it('keeps image model 404 failures scoped to the failing account', async () => {
    const { accountLeaseService, modelAvailability, service } = createService();
    const error = new UpstreamRequestError({
      message: `Model ${imageModel} is not supported`,
      status: 404,
    });

    await service.applyPenalty('acc-a', imageModel, error);

    expect(accountLeaseService.markAsForbidden).not.toHaveBeenCalled();
    expect(modelAvailability.isCapabilityBlocked('acc-a', imageModel)).toBe(true);
    expect(modelAvailability.isCapabilityBlocked('acc-b', imageModel)).toBe(false);
    expect(modelAvailability.getSnapshot()).toMatchObject([
      { accountId: 'acc-a', modelId: 'gemini-pro-image', reason: 'model_not_supported' },
    ]);
  });

  it('does not publish a capability failure for an ambiguous text-model 404', async () => {
    const { accountLeaseService, modelAvailability, service } = createService();
    const error = new UpstreamRequestError({
      message: 'Requested entity was not found',
      status: 404,
    });

    await service.applyPenalty('acc-a', 'gemini-3.6-flash-low', error);

    expect(accountLeaseService.markFromUpstreamError).toHaveBeenCalled();
    expect(modelAvailability.getSnapshot()).toEqual([]);
  });
});
