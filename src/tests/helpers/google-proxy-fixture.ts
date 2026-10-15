import http from 'node:http';
import axios from 'axios';
import { vi } from 'vitest';
import { ConfigManager } from '@/modules/config/ipc/manager';
import { DEFAULT_APP_CONFIG } from '@/modules/config/types';

type ProxySource = 'config' | 'account' | 'environment' | 'electron';

/** Real wire-level rejection keeps proxy transport checks separate from OAuth callback assertions. */
export async function createGoogleProxyFixture(source: ProxySource, status: 502 | 503) {
  for (const key of [
    'http_proxy',
    'https_proxy',
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'ALL_PROXY',
    'all_proxy',
    'NO_PROXY',
    'no_proxy',
    'npm_config_http_proxy',
    'npm_config_https_proxy',
    'npm_config_proxy',
    'npm_config_no_proxy',
    'ELECTRON_PROXY_SERVER',
  ]) {
    vi.stubEnv(key, '');
  }
  const request = axios.request.bind(axios);
  vi.spyOn(axios, 'request').mockImplementation((config) =>
    request({ ...config, adapter: 'http' }),
  );
  let requests = 0;
  let forwardedRequests = 0;
  let authenticatedConnects = 0;
  const proxy = http.createServer((request, response) => {
    forwardedRequests += 1;
    request.resume();
    response.writeHead(502).end();
  });
  proxy.on('connect', (request, socket) => {
    requests += 1;
    if (
      request.url === 'oauth2.googleapis.com:443' &&
      request.headers['proxy-authorization'] ===
        'Basic ' + Buffer.from('synthetic:private-sentinel').toString('base64')
    ) {
      authenticatedConnects += 1;
    }
    const body =
      status === 502
        ? '<html>private-sentinel</html>'
        : JSON.stringify({
            error: 'temporarily_unavailable',
            error_description: 'private-sentinel',
          });
    const mediaType = status === 502 ? 'text/html' : 'application/json';
    socket.end(
      'HTTP/1.1 ' +
        status +
        ' Rejected\r\nContent-Type: ' +
        mediaType +
        '\r\nServer: private-sentinel\r\nContent-Length: ' +
        Buffer.byteLength(body) +
        '\r\nConnection: close\r\n\r\n' +
        body,
    );
  });
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  const address = proxy.address();
  if (!address || typeof address === 'string') {
    throw new Error('Synthetic proxy has no port');
  }
  const proxyUrl = `http://synthetic:private-sentinel@127.0.0.1:${address.port}`;
  if (source === 'environment') {
    vi.stubEnv('https_proxy', proxyUrl);
  }
  if (source === 'electron') {
    vi.stubEnv('ELECTRON_PROXY_SERVER', proxyUrl);
  }
  vi.mocked(ConfigManager.loadConfig).mockReturnValue({
    ...DEFAULT_APP_CONFIG,
    proxy: {
      ...DEFAULT_APP_CONFIG.proxy,
      upstream_proxy: {
        enabled: source === 'config',
        url: source === 'config' ? proxyUrl : '',
      },
    },
  });
  return {
    proxyUrl,
    counts: () => ({ requests, forwardedRequests, authenticatedConnects }),
    close: async () => {
      proxy.closeAllConnections();
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
    },
  };
}
