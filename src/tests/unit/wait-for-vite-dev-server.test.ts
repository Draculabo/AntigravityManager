import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { waitForViteDevServer } from '@/modules/app-shell/utils/wait-for-vite-dev-server';

describe('waitForViteDevServer', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('probes directly with a timeout and retries unsuccessful HTTP statuses', async () => {
    const get = vi
      .spyOn(axios, 'get')
      .mockResolvedValueOnce({ status: 503 } as never)
      .mockResolvedValueOnce({ status: 204 } as never);

    await expect(
      waitForViteDevServer('http://127.0.0.1:5173', { delayMs: 0, maxRetries: 2 }),
    ).resolves.toBe(0);

    expect(get).toHaveBeenCalledTimes(2);
    expect(get).toHaveBeenCalledWith('http://127.0.0.1:5173', {
      proxy: false,
      timeout: 1000,
      validateStatus: expect.any(Function),
    });
    const requestConfig = get.mock.calls[0][1];
    expect(requestConfig?.validateStatus?.(503)).toBe(true);
  });

  it('retries a timed-out request and accepts the next successful response', async () => {
    const get = vi
      .spyOn(axios, 'get')
      .mockRejectedValueOnce(new axios.AxiosError('timeout', 'ECONNABORTED'))
      .mockResolvedValueOnce({ status: 200 } as never);

    await expect(
      waitForViteDevServer('http://127.0.0.1:5173', { delayMs: 0, maxRetries: 2 }),
    ).resolves.toBe(0);
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('returns null after all connection failures or unsuccessful statuses', async () => {
    const request = vi
      .fn<() => Promise<{ status: number }>>()
      .mockRejectedValueOnce(new Error('connection refused'))
      .mockResolvedValueOnce({ status: 503 });

    await expect(
      waitForViteDevServer('http://127.0.0.1:5173', { delayMs: 0, maxRetries: 2, request }),
    ).resolves.toBeNull();
    expect(request).toHaveBeenCalledTimes(2);
  });
});
