import net from 'node:net';

import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';

type ProxyProbe = {
  readonly port: number;
  readonly connections: () => string[];
  readonly close: () => Promise<void>;
};

async function startProxyProbe(): Promise<ProxyProbe> {
  const requests: string[] = [];
  const server = net.createServer((socket) => {
    let data = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      data += chunk;
      const headerEnd = data.indexOf('\r\n');
      if (headerEnd >= 0) {
        requests.push(data.slice(0, headerEnd));
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n', () => {
          socket.destroy();
        });
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error('Local proxy probe did not expose a TCP address');
  }

  return {
    port: address.port,
    connections: () => [...requests],
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

describe('Google API local proxy routing', () => {
  const originalAdapter = axios.defaults.adapter;

  afterEach(() => {
    axios.defaults.adapter = originalAdapter;
    vi.restoreAllMocks();
    vi.resetModules();
    vi.unstubAllEnvs();
  });

  it('routes project, credits and quota requests through the explicit account proxy', async () => {
    axios.defaults.adapter = axios.getAdapter('http');
    const accountProxy = await startProxyProbe();
    const globalProxy = await startProxyProbe();

    try {
      vi.stubEnv('HTTPS_PROXY', `http://127.0.0.1:${globalProxy.port}`);
      vi.stubEnv('https_proxy', `http://127.0.0.1:${globalProxy.port}`);
      vi.stubEnv('NO_PROXY', '');
      vi.stubEnv('no_proxy', '');

      const { ConfigManager } = await import('@/modules/config/ipc/manager');
      vi.spyOn(ConfigManager, 'loadConfig').mockReturnValue({
        proxy: {
          upstream_proxy: {
            enabled: false,
          },
        },
      } as never);

      const { GoogleAPIService } =
        await import('@/modules/cloud-account/services/GoogleAPIService');
      const accountProxyUrl = `http://127.0.0.1:${accountProxy.port}`;

      await expect(
        GoogleAPIService.fetchAICredits('synthetic-token', accountProxyUrl),
      ).resolves.toBeNull();

      expect(accountProxy.connections()).toHaveLength(1);
      expect(globalProxy.connections()).toEqual([]);
      expect(accountProxy.connections().every((line) => line.startsWith('CONNECT '))).toBe(true);
    } finally {
      await accountProxy.close();
      await globalProxy.close();
    }
  });

  it('uses the environment proxy when no account or app proxy is configured', async () => {
    axios.defaults.adapter = axios.getAdapter('http');
    const globalProxy = await startProxyProbe();

    try {
      const { ConfigManager } = await import('@/modules/config/ipc/manager');
      vi.spyOn(ConfigManager, 'loadConfig').mockReturnValue({
        proxy: {
          upstream_proxy: {
            enabled: true,
            url: `http://127.0.0.1:${globalProxy.port}`,
          },
        },
      } as never);

      const { GoogleAPIService } =
        await import('@/modules/cloud-account/services/GoogleAPIService');
      await expect(GoogleAPIService.fetchAICredits('synthetic-token')).resolves.toBeNull();

      expect(globalProxy.connections()).toHaveLength(1);
      expect(globalProxy.connections()[0]).toMatch(/^CONNECT /);
    } finally {
      await globalProxy.close();
    }
  });
});
