import axios from 'axios';
import { performance } from 'node:perf_hooks';
import { setServerConfig } from '@/server/server-config';
import { DEFAULT_APP_CONFIG } from '@/modules/config/types';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { explicitContextCacheManager } from '@/server/gateway/modules/gemini/explicit-context-cache.store';
import { GeminiClient } from '@/server/gateway/modules/gemini/gemini-client.service';
import { Upstream4xxCaptureService } from '@/server/gateway/common/upstream-4xx-capture.service';

describe('GeminiClient explicit context cache', () => {
  it('spends one deadline across cache creation, rejected cache and full-request retry', async () => {
    let now = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    vi.stubEnv('PROXY_INTERNAL_BASE_URLS', 'http://cache-deadline.invalid/v1internal');
    vi.stubEnv('PROXY_CONTEXT_CACHE_ENABLED', 'true');
    vi.stubEnv('PROXY_CONTEXT_CACHE_MIN_CHARACTERS', '1');
    setServerConfig({ ...DEFAULT_APP_CONFIG.proxy, request_timeout: 10, generation_timeout: 10 });
    const post = vi
      .spyOn(axios, 'post')
      .mockImplementationOnce(async () => {
        now += 4000;
        return {
          status: 200,
          data: {
            name: 'projects/project-a/locations/us-central1/cachedContents/deadline',
            expireTime: '2099-01-01T00:00:00Z',
          },
        };
      })
      .mockImplementationOnce(async () => {
        now += 3000;
        throw new axios.AxiosError('Cached content missing', undefined, undefined, undefined, {
          status: 400,
          statusText: '',
          headers: {},
          config: { headers: new axios.AxiosHeaders() },
          data: { error: { message: 'Cached content missing' } },
        });
      })
      .mockResolvedValueOnce({ status: 200, data: { candidates: [] } });
    try {
      await new GeminiClient(new Upstream4xxCaptureService()).generateInternal(
        {
          model: 'gemini-2.5-pro',
          project: 'project-a',
          requestId: 'cache-deadline',
          userAgent: 'fixture',
          request: {
            contents: [{ role: 'user', parts: [{ text: 'Controlled cache deadline.' }] }],
            systemInstruction: { parts: [{ text: 'You are a coding assistant.' }] },
            tools: [{ functionDeclarations: [{ name: 'read_file' }] }],
          },
        },
        'synthetic-token',
      );
      expect(post.mock.calls.map(([, , config]) => config?.timeout)).toEqual([10000, 6000, 3000]);
      expect(post.mock.calls.slice(1).map(([, , config]) => config?.signal?.aborted)).toEqual([
        false,
        false,
      ]);
    } finally {
      setServerConfig(DEFAULT_APP_CONFIG.proxy);
    }
  });
  it('validates endpoint routing before creating a billable explicit cache resource', async () => {
    vi.stubEnv('PROXY_INTERNAL_BASE_URLS', 'https://private-user:private-secret@invalid.example');
    vi.stubEnv('PROXY_CONTEXT_CACHE_ENABLED', 'true');
    vi.stubEnv('PROXY_CONTEXT_CACHE_MIN_CHARACTERS', '1');
    const post = vi.spyOn(axios, 'post').mockResolvedValue({ data: {} } as never);
    const client = new GeminiClient(new Upstream4xxCaptureService());

    await expect(
      client.generateInternal(
        {
          model: 'gemini-2.5-pro',
          project: 'project-a',
          requestId: 'invalid-route',
          userAgent: 'test',
          request: {
            contents: [{ role: 'user', parts: [{ text: 'What changed?' }] }],
            systemInstruction: { parts: [{ text: 'You are a coding assistant.' }] },
            tools: [{ functionDeclarations: [{ name: 'read_file' }] }],
          },
        },
        'access-token',
      ),
    ).rejects.toMatchObject({ name: 'UpstreamEndpointConfigurationError' });

    expect(post).not.toHaveBeenCalled();
    expect(explicitContextCacheManager.getStats().activeEntries).toBe(0);
  });
  afterEach(() => {
    explicitContextCacheManager.clear();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('creates a resource then injects it without resending the cached static prefix', async () => {
    vi.stubEnv('PROXY_CONTEXT_CACHE_MIN_CHARACTERS', '1');
    const post = vi.spyOn(axios, 'post');
    post
      .mockResolvedValueOnce({
        data: {
          expireTime: '2099-01-01T00:00:00Z',
          name: 'projects/project-a/locations/us-central1/cachedContents/cache-a',
        },
      } as never)
      .mockResolvedValueOnce({ data: { candidates: [] } } as never);

    const client = new GeminiClient(new Upstream4xxCaptureService());
    await client.generateInternal(
      {
        model: 'gemini-2.5-pro',
        project: 'project-a',
        requestId: 'request-a',
        requestType: 'agent',
        userAgent: 'test-agent',
        request: {
          contents: [{ parts: [{ text: 'What changed?' }], role: 'user' }],
          systemInstruction: { parts: [{ text: 'You are a coding assistant.' }] },
          toolConfig: { functionCallingConfig: { mode: 'VALIDATED' } },
          tools: [{ functionDeclarations: [{ name: 'read_file' }] }],
        },
      },
      'access-token',
    );

    expect(post).toHaveBeenCalledTimes(2);
    expect(post.mock.calls[0]?.[0]).toContain('/cachedContents');
    expect(post.mock.calls[0]?.[1]).toMatchObject({
      model: 'projects/project-a/locations/us-central1/publishers/google/models/gemini-2.5-pro',
      systemInstruction: { parts: [{ text: 'You are a coding assistant.' }] },
      toolConfig: { functionCallingConfig: { mode: 'VALIDATED' } },
      tools: [{ functionDeclarations: [{ name: 'read_file' }] }],
    });

    const generatedPayload = JSON.parse(String(post.mock.calls[1]?.[1])) as {
      request: Record<string, unknown>;
    };
    expect(generatedPayload.request).toMatchObject({
      cachedContent: 'projects/project-a/locations/us-central1/cachedContents/cache-a',
      contents: [{ parts: [{ text: 'What changed?' }], role: 'user' }],
    });
    expect(generatedPayload.request).not.toHaveProperty('systemInstruction');
    expect(generatedPayload.request).not.toHaveProperty('tools');
    expect(generatedPayload.request).not.toHaveProperty('toolConfig');
  });

  it('drops a rejected cache resource and retries the original request once', async () => {
    vi.stubEnv('PROXY_INTERNAL_BASE_URLS', 'https://single-fixture.invalid/v1internal');
    vi.stubEnv('PROXY_CONTEXT_CACHE_MIN_CHARACTERS', '1');
    const post = vi.spyOn(axios, 'post');
    const missingCacheError = new axios.AxiosError(
      'cachedContent not found',
      'ERR_BAD_REQUEST',
      undefined,
      undefined,
      {
        config: {} as never,
        data: { error: { message: 'cachedContent not found' } },
        headers: {},
        status: 404,
        statusText: 'Not Found',
      },
    );
    post
      .mockResolvedValueOnce({
        data: {
          expireTime: '2099-01-01T00:00:00Z',
          name: 'projects/project-a/locations/us-central1/cachedContents/cache-a',
        },
      } as never)
      .mockRejectedValueOnce(missingCacheError)
      .mockResolvedValueOnce({ data: { candidates: [] } } as never);

    const client = new GeminiClient(new Upstream4xxCaptureService());
    await client.generateInternal(
      {
        model: 'gemini-2.5-pro',
        project: 'project-a',
        requestId: 'request-a',
        requestType: 'agent',
        userAgent: 'test-agent',
        request: {
          contents: [{ parts: [{ text: 'What changed?' }], role: 'user' }],
          systemInstruction: { parts: [{ text: 'You are a coding assistant.' }] },
          tools: [{ functionDeclarations: [{ name: 'read_file' }] }],
        },
      },
      'access-token',
    );

    expect(post).toHaveBeenCalledTimes(3);
    const retriedPayload = JSON.parse(String(post.mock.calls[2]?.[1])) as {
      request: Record<string, unknown>;
    };
    expect(retriedPayload.request).toMatchObject({
      systemInstruction: { parts: [{ text: 'You are a coding assistant.' }] },
      tools: [{ functionDeclarations: [{ name: 'read_file' }] }],
    });
    expect(retriedPayload.request).not.toHaveProperty('cachedContent');
    expect(explicitContextCacheManager.getStats()).toMatchObject({
      activeEntries: 0,
      invalidations: 1,
    });
  });
});
