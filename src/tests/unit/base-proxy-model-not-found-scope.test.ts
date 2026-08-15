import { afterEach, describe, expect, it, vi } from 'vitest';
import { BaseProxyService } from '@/modules/proxy-gateway/server/common/base-proxy.service';
import { UpstreamRequestError } from '@/modules/proxy-gateway/server/common/exceptions/upstream-request.exception';
import type { AccountLeaseService } from '@/modules/proxy-gateway/server/modules/account-lease/account-lease.service';
import type { GeminiClient } from '@/modules/proxy-gateway/server/modules/gemini/gemini-client.service';
import { proxyModelAvailabilityStore } from '@/modules/proxy-gateway/server/shared/services/model-availability.service';

class TestProxyService extends BaseProxyService {
  applyPenalty(accountId: string, model: string, error: unknown): Promise<void> {
    return this.applyUpstreamPenalty(accountId, model, error);
  }
}

function createService() {
  const accountLeaseService = {
    markModelUnrequestable: vi.fn(),
    markFromUpstreamError: vi.fn().mockResolvedValue(undefined),
    recordParityError: vi.fn(),
  } as unknown as AccountLeaseService;

  return {
    accountLeaseService,
    service: new TestProxyService(accountLeaseService, {} as GeminiClient),
  };
}

const imageModel = 'gemini-3-pro-image';

afterEach(() => {
  proxyModelAvailabilityStore.clearModel('acc-a', imageModel);
});

describe('BaseProxyService model-not-found penalty scope', () => {
  it('keeps image model 404 failures scoped to the failing account', async () => {
    const { accountLeaseService, service } = createService();
    const error = new UpstreamRequestError({
      message: 'Requested entity was not found',
      status: 404,
    });

    await service.applyPenalty('acc-a', imageModel, error);

    expect(accountLeaseService.markModelUnrequestable).not.toHaveBeenCalled();
    expect(proxyModelAvailabilityStore.getSnapshot()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          accountId: 'acc-a',
          modelId: imageModel,
          reason: 'model_not_supported',
        }),
      ]),
    );
  });

  it('preserves global sibling rerouting for non-image model 404 failures', async () => {
    const { accountLeaseService, service } = createService();
    const error = new UpstreamRequestError({
      message: 'Requested entity was not found',
      status: 404,
    });

    await service.applyPenalty('acc-a', 'gemini-3.6-flash-low', error);

    expect(accountLeaseService.markModelUnrequestable).toHaveBeenCalledWith(
      'gemini-3.6-flash-low',
    );
  });
});
