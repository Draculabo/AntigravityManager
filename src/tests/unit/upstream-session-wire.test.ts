import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createUpstreamSessionIdentity } from '@/server/gateway/common/upstream-session-identity';

import { DEFAULT_APP_CONFIG } from '@/modules/config/types';
import { setServerConfig } from '@/server/server-config';
import { GeminiClient } from '@/server/gateway/modules/gemini/gemini-client.service';
import { Upstream4xxCaptureService } from '@/server/gateway/common/upstream-4xx-capture.service';
import type { GeminiInternalRequest } from '@/modules/proxy-gateway/antigravity/types';
import { explicitContextCacheManager } from '@/server/gateway/modules/gemini/explicit-context-cache.store';

const axiosMock = vi.hoisted(() => ({
  post: vi.fn(),
  create: vi.fn(() => ({
    get: vi.fn(),
    post: vi.fn(),
  })),
  isAxiosError: vi.fn(() => false),
}));

vi.mock('axios', () => ({
  default: axiosMock,
  create: axiosMock.create,
  post: axiosMock.post,
  isAxiosError: axiosMock.isAxiosError,
}));

describe('scoped upstream session wire identity', () => {
  const body: GeminiInternalRequest = {
    model: 'claude-sonnet-4-6',
    project: 'synthetic-project',
    requestId: 'synthetic-request',
    userAgent: 'synthetic-test',
    request: { contents: [{ role: 'user', parts: [{ text: 'Synthetic test' }] }] },
  };
  beforeEach(() => {
    axiosMock.post.mockReset();
    axiosMock.isAxiosError.mockReturnValue(true);
    axiosMock.post.mockResolvedValue({ status: 200, headers: {}, data: { candidates: [] } });
    vi.stubEnv('PROXY_INTERNAL_BASE_URLS', '');
    vi.stubEnv('ANTIGRAVITY_INTERNAL_BASE_URLS', '');
    vi.stubEnv('PROXY_CONTEXT_CACHE_ENABLED', 'false');
    setServerConfig(DEFAULT_APP_CONFIG.proxy);
  });
  afterEach(() => vi.unstubAllEnvs());

  it('reports the actual scoped wire request in a final 4xx diagnostic', async () => {
    const capture = new Upstream4xxCaptureService();
    const saved = vi.spyOn(capture, 'capture').mockResolvedValue();
    axiosMock.post.mockRejectedValue({
      message: 'Bad request',
      response: { status: 400, data: { error: { message: 'Bad request' } } },
    });
    try {
      const identity = createUpstreamSessionIdentity('account-a', 'synthetic-store');
      await expect(
        new GeminiClient(capture).generateInternal(
          structuredClone(body),
          'synthetic-token',
          undefined,
          undefined,
          undefined,
          { upstreamSession: identity },
        ),
      ).rejects.toMatchObject({ status: 400 });
      expect(axiosMock.post).toHaveBeenCalledOnce();
      const wire: unknown = JSON.parse(axiosMock.post.mock.calls[0][1]);
      expect(saved.mock.calls.map(([input]) => input.upstreamRequest)).toEqual([wire]);
    } finally {
      saved.mockRestore();
    }
  });

  it('preserves scoped identity and renews the send ID when a cached prefix is rejected', async () => {
    vi.stubEnv('PROXY_CONTEXT_CACHE_ENABLED', 'true');
    vi.stubEnv('PROXY_INTERNAL_BASE_URLS', 'http://daily');
    const cache = vi
      .spyOn(explicitContextCacheManager, 'resolve')
      .mockResolvedValue('cachedContents/synthetic');
    const capture = new Upstream4xxCaptureService();
    const saved = vi.spyOn(capture, 'capture').mockResolvedValue();
    const request = structuredClone(body);
    request.request.systemInstruction = { parts: [{ text: 'S'.repeat(9000) }] };
    axiosMock.post.mockRejectedValueOnce({
      message: 'Cached content missing',
      response: { status: 404, data: { error: { message: 'Cached content missing' } } },
    });
    const identity = createUpstreamSessionIdentity('account-a', 'synthetic-store');
    try {
      await new GeminiClient(capture).generateInternal(
        request,
        'synthetic-token',
        undefined,
        undefined,
        undefined,
        { upstreamSession: identity },
      );
      const schema = z.object({
        requestId: z.string(),
        request: z.object({
          sessionId: z.string(),
          cachedContent: z.string().optional(),
          systemInstruction: z
            .object({ parts: z.array(z.object({ text: z.string() })) })
            .optional(),
        }),
      });
      const payloads = axiosMock.post.mock.calls.map(([, payload]) =>
        schema.parse(JSON.parse(payload)),
      );
      expect(payloads).toHaveLength(2);
      expect(payloads.map((payload) => payload.request.sessionId)).toEqual([
        identity.sessionId,
        identity.sessionId,
      ]);
      expect(payloads[0].request.cachedContent).toBe('cachedContents/synthetic');
      expect(payloads[0].request.systemInstruction).toBeUndefined();
      expect(payloads[1].request.cachedContent).toBeUndefined();
      expect(payloads[1].request.systemInstruction).toEqual(request.request.systemInstruction);
      expect(payloads[0].requestId).not.toBe(payloads[1].requestId);
    } finally {
      cache.mockRestore();
      saved.mockRestore();
    }
  });

  it.each([false, true])(
    'keeps scoped sessions and stops on account quota, stream=%s',
    async (stream) => {
      axiosMock.post.mockRejectedValue({
        response: { status: 429, headers: {}, data: { error: { status: 'RESOURCE_EXHAUSTED' } } },
      });
      const client = new GeminiClient(new Upstream4xxCaptureService());
      const input = structuredClone(body);
      const original = structuredClone(input);
      const identity = createUpstreamSessionIdentity('account-a', 'synthetic-store');
      if (stream) {
        await expect(
          client.streamGenerateInternal(input, 'synthetic-token', undefined, undefined, undefined, {
            upstreamSession: identity,
          }),
        ).rejects.toMatchObject({ status: 429 });
      } else {
        await expect(
          client.generateInternal(input, 'synthetic-token', undefined, undefined, undefined, {
            upstreamSession: identity,
          }),
        ).rejects.toMatchObject({ status: 429 });
      }
      expect(axiosMock.post).toHaveBeenCalledOnce();
      expect(input).toEqual(original);
    },
  );
});
