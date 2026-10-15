// @vitest-environment node
import http from 'node:http';
import { once } from 'node:events';
import type { Duplex } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfigManager } from '@/modules/config/ipc/manager';
import { DEFAULT_APP_CONFIG } from '@/modules/config/types';
import { UpstreamProxyUrlSchema } from '@/modules/config/upstream-proxy.schema';
import {
  GoogleAPIService,
  GoogleUserInfoHttpError,
} from '@/modules/cloud-account/services/GoogleAPIService';

afterEach(() => vi.restoreAllMocks());

function configureProxy(url: string) {
  const config = structuredClone(DEFAULT_APP_CONFIG);
  config.proxy.upstream_proxy = { enabled: true, url: UpstreamProxyUrlSchema.parse(url) };
  vi.spyOn(ConfigManager, 'loadConfig').mockReturnValue(config);
}

describe('Google API HTTP proxy transport', () => {
  it('uses CONNECT for Google HTTPS and preserves a proxy rejection without forwarding credentials', async () => {
    const requests: Array<{
      method: string | undefined;
      url: string | undefined;
      authorization?: string;
    }> = [];
    const sockets = new Set<Duplex>();
    const profile = {
      id: 'synthetic-user',
      email: 'synthetic@example.com',
      name: 'Synthetic User',
    };
    const proxy = http.createServer((request, response) => {
      requests.push({ method: request.method, url: request.url });
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(profile));
    });
    proxy.on('connect', (request, socket) => {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
      requests.push({
        method: request.method,
        url: request.url,
        authorization: request.headers.authorization,
      });
      socket.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
    });
    proxy.listen(0, '127.0.0.1');
    await once(proxy, 'listening');
    try {
      const address = proxy.address();
      if (!address || typeof address === 'string') {
        throw new Error('The synthetic proxy has no TCP port.');
      }
      configureProxy(`http://127.0.0.1:${address.port}`);
      await expect(GoogleAPIService.getUserInfo('synthetic-invalid-token')).rejects.toMatchObject({
        classification: {
          reason: 'http-rejected',
          upstreamStatus: 502,
          http: { route: 'https-connect' },
        },
      });
      expect(requests).toEqual([
        { method: 'CONNECT', url: 'www.googleapis.com:443', authorization: undefined },
      ]);
    } finally {
      for (const socket of sockets) {
        socket.destroy();
      }
      proxy.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        proxy.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  const liveProxyUrl = process.env.AGM_LIVE_UPSTREAM_PROXY_URL;
  if (liveProxyUrl) {
    it('reaches Google through the explicitly selected live proxy without real account credentials', async () => {
      configureProxy(liveProxyUrl);
      await expect(GoogleAPIService.getUserInfo('synthetic-invalid-token')).rejects.toEqual(
        new GoogleUserInfoHttpError(401),
      );
    }, 45_000);
  }
});
