import { afterEach, describe, expect, it, vi } from 'vitest';
import { mockAxiosRequests } from '../helpers/mock-axios-request';

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.useRealTimers();
});

describe('quota recovery cancellation at the Google transport boundary', () => {
  it.each(['load', 'models', 'summary', 'fallback'] as const)(
    'stops %s without another endpoint attempt',
    async (phase) => {
      vi.useFakeTimers();
      let entered!: () => void;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const controller = new AbortController();
      const reason = new Error('Synthetic quota budget exhausted');
      const transport = vi.fn(
        async (
          url: string,
          options: import('../helpers/mock-axios-request').MockHttpRequestOptions,
        ) => {
          const current = url.includes('loadCodeAssist')
            ? 'load'
            : url.includes('retrieveUserQuotaSummary')
              ? 'summary'
              : 'models';
          if (phase === 'fallback' && current === 'models') {
            entered();
            return { status: 503, json: async () => ({ error: 'synthetic-unavailable' }) };
          }
          if (current === phase) {
            entered();
            return new Promise<import('../helpers/mock-axios-request').MockHttpResponse>(
              (_resolve, reject) => {
                options.signal?.addEventListener?.('abort', () => reject(reason), { once: true });
              },
            );
          }
          return {
            status: 200,
            json: async () =>
              current === 'load'
                ? { cloudaicompanionProject: 'synthetic-project' }
                : { models: {} },
          };
        },
      );
      mockAxiosRequests(transport);
      const { GoogleAPIService } =
        await import('@/modules/cloud-account/services/GoogleAPIService');
      const pending = GoogleAPIService.fetchQuota(
        'synthetic-cancel-access',
        undefined,
        controller.signal,
      );
      const rejected = expect(pending).rejects.toBe(reason);
      await started;
      controller.abort(reason);
      await rejected;
      expect(transport).toHaveBeenCalledTimes(phase === 'load' ? 1 : phase === 'summary' ? 3 : 2);
      expect(vi.getTimerCount()).toBe(0);
    },
  );
});
