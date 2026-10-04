import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_APP_CONFIG, type ProxyConfig } from '@/modules/config/types';
import { setServerConfig } from '@/server/server-config';
import { GeminiClient } from '@/modules/proxy-gateway/server/modules/gemini/gemini-client.service';
import { Upstream4xxCaptureService } from '@/modules/proxy-gateway/server/common/upstream-4xx-capture.service';
import type { GeminiInternalRequest } from '@/modules/proxy-gateway/antigravity/types';

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

function createProxyConfig(url: string): ProxyConfig {
  return {
    ...DEFAULT_APP_CONFIG.proxy,
    upstream_proxy: {
      enabled: true,
      url,
    },
  };
}

describe('GeminiClient upstream proxy config', () => {
  beforeEach(() => {
    axiosMock.post.mockReset();
    axiosMock.isAxiosError.mockReturnValue(false);
    axiosMock.post.mockResolvedValue({ data: { candidates: [] } });
  });

  it('reads upstream proxy config on each request so runtime changes take effect', async () => {
    const client = new GeminiClient(new Upstream4xxCaptureService());

    setServerConfig(createProxyConfig('http://user:pass@127.0.0.1:8080'));
    await client.generate('gemini-3-flash', { contents: [] } as never, 'access-token');

    setServerConfig(createProxyConfig('http://127.0.0.1:9090'));
    await client.generate('gemini-3-flash', { contents: [] } as never, 'access-token');

    expect(axiosMock.post.mock.calls[0]?.[2]?.proxy).toEqual({
      protocol: 'http',
      host: '127.0.0.1',
      port: 8080,
      auth: {
        username: 'user',
        password: 'pass',
      },
    });
    expect(axiosMock.post.mock.calls[1]?.[2]?.proxy).toEqual({
      protocol: 'http',
      host: '127.0.0.1',
      port: 9090,
    });
  });
});

describe('GeminiClient internal endpoint selection', () => {
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

  it('uses Daily first and falls back to production with the same request and token', async () => {
    axiosMock.post.mockRejectedValueOnce({
      response: { status: 429, headers: {}, data: { error: { status: 'RESOURCE_EXHAUSTED' } } },
    });
    const client = new GeminiClient(new Upstream4xxCaptureService());
    await expect(client.generateInternal(body, 'synthetic-token')).resolves.toEqual({
      candidates: [],
    });
    expect(axiosMock.post.mock.calls.map(([url]) => url)).toEqual([
      'https://daily-cloudcode-pa.googleapis.com/v1internal:generateContent',
      'https://cloudcode-pa.googleapis.com/v1internal:generateContent',
    ]);
    expect(axiosMock.post.mock.calls[0][1]).toEqual(axiosMock.post.mock.calls[1][1]);
    expect(axiosMock.post.mock.calls.map(([, , options]) => options.headers.Authorization)).toEqual(
      ['Bearer synthetic-token', 'Bearer synthetic-token'],
    );
  });

  it('honors an explicit endpoint order and does not probe another endpoint after success', async () => {
    vi.stubEnv(
      'PROXY_INTERNAL_BASE_URLS',
      'http://127.0.0.1:19001/first/,http://127.0.0.1:19002/second',
    );
    const client = new GeminiClient(new Upstream4xxCaptureService());
    await client.generateInternal(body, 'synthetic-token');
    expect(axiosMock.post.mock.calls.map(([url]) => url)).toEqual([
      'http://127.0.0.1:19001/first:generateContent',
    ]);
  });
});
