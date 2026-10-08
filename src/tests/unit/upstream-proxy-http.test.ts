// @vitest-environment node
import http from 'node:http';
import { once } from 'node:events';
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
  it('sends the Google profile request through the configured HTTP proxy using real sockets', async () => {
    const requests: Array<{ method: string | undefined; url: string | undefined }> = [];
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
    proxy.listen(0, '127.0.0.1');
    await once(proxy, 'listening');
    try {
      const address = proxy.address();
      if (!address || typeof address === 'string') {
        throw new Error('The synthetic proxy has no TCP port.');
      }
      configureProxy(`http://127.0.0.1:${address.port}`);
      expect(await GoogleAPIService.getUserInfo('synthetic-invalid-token')).toEqual({
        ...profile,
        verified_email: false,
      });
      expect(requests).toEqual([
        { method: 'GET', url: 'https://www.googleapis.com/oauth2/v2/userinfo' },
      ]);
    } finally {
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
