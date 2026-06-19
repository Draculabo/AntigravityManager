import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_APP_CONFIG, type ProxyConfig } from '@/modules/config/types';
import { setServerConfig } from '@/server/server-config';
import { GeminiClient } from '@/modules/proxy-gateway/server/clients/gemini.client';

const axiosMock = vi.hoisted(() => ({
  post: vi.fn(),
  isAxiosError: vi.fn(() => false),
}));

vi.mock('axios', () => ({
  default: axiosMock,
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
    const client = new GeminiClient();

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
