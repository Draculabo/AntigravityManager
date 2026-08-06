import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { explicitContextCacheManager } from '@/modules/proxy-gateway/server/modules/gemini/explicit-context-cache.store';
import { GeminiClient } from '@/modules/proxy-gateway/server/modules/gemini/gemini-client.service';

describe('GeminiClient explicit context cache', () => {
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

    const client = new GeminiClient();
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

    const client = new GeminiClient();
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
