import { afterEach, describe, expect, it, vi } from 'vitest';
import { mockAxiosRequests, type MockHttpResponse } from '../helpers/mock-axios-request';

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('OAuth refresh cancellation at the Google transport boundary', () => {
  it('does not dispatch an already cancelled refresh', async () => {
    const transport = vi.fn(async () => ({ status: 200 }));
    mockAxiosRequests(transport);
    const { GoogleAPIService } = await import('@/modules/cloud-account/services/GoogleAPIService');
    const controller = new AbortController();
    const reason = new Error('Synthetic pre-dispatch cancellation');
    controller.abort(reason);
    await expect(
      GoogleAPIService.refreshAccessToken(
        'synthetic-grant',
        undefined,
        undefined,
        controller.signal,
      ),
    ).rejects.toBe(reason);
    expect(transport).not.toHaveBeenCalled();
  });

  it('rejects a successful late response from a transport that ignores cancellation', async () => {
    const entered = Promise.withResolvers<void>();
    const response = Promise.withResolvers<MockHttpResponse>();
    const transport = vi.fn(async () => {
      entered.resolve();
      return response.promise;
    });
    mockAxiosRequests(transport);
    const { GoogleAPIService } = await import('@/modules/cloud-account/services/GoogleAPIService');
    const controller = new AbortController();
    const reason = new Error('Synthetic in-flight cancellation');
    const pending = GoogleAPIService.refreshAccessToken(
      'synthetic-grant',
      undefined,
      undefined,
      controller.signal,
    );
    const failed = expect(pending).rejects.toBe(reason);
    await entered.promise;
    controller.abort(reason);
    response.resolve({
      status: 200,
      json: async () => ({
        access_token: 'synthetic-late-access',
        expires_in: 3600,
        token_type: 'Bearer',
      }),
    });
    await failed;
    expect(transport).toHaveBeenCalledTimes(1);
  });
});
