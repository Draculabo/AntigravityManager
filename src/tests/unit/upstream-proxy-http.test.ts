// @vitest-environment node
import http from 'node:http';
import { once } from 'node:events';
import { connect } from 'node:net';
import type { Duplex } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfigManager } from '@/modules/config/ipc/manager';
import { DEFAULT_APP_CONFIG } from '@/modules/config/types';
import { UpstreamProxyUrlSchema } from '@/modules/config/upstream-proxy.schema';
import { GeminiClient } from '@/server/gateway/modules/gemini/gemini-client.service';
import { Upstream4xxCaptureService } from '@/server/gateway/common/upstream-4xx-capture.service';
import { GeminiHttpTransport } from '@/server/gateway/modules/gemini/gemini-http-transport';
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

  it('tunnels Gemini generation without exposing upstream credentials to an HTTP proxy', async () => {
    const requests: Array<Array<string | undefined>> = [];
    const proxy = http.createServer((request, response) => {
      requests.push([
        request.method,
        request.url,
        request.headers.authorization,
        request.headers['proxy-authorization'],
      ]);
      response.writeHead(502).end();
    });
    proxy.on('connect', (request, socket) => {
      requests.push([
        request.method,
        request.url,
        request.headers.authorization,
        request.headers['proxy-authorization'],
      ]);
      socket.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
    });
    proxy.listen(0, '127.0.0.1');
    await once(proxy, 'listening');
    try {
      const address = proxy.address();
      if (!address || typeof address === 'string') {
        throw new Error('The synthetic proxy has no TCP port.');
      }
      const client = new GeminiClient(new Upstream4xxCaptureService());
      await expect(
        client.generate(
          'gemini-3-flash',
          { contents: [] },
          'synthetic-upstream-token',
          `http://proxy%40user:example%3Apassword@127.0.0.1:${address.port}`,
        ),
      ).rejects.toMatchObject({ status: 502 });
      expect(requests).toEqual([
        [
          'CONNECT',
          'generativelanguage.googleapis.com:443',
          undefined,
          `Basic ${Buffer.from('proxy@user:example:password').toString('base64')}`,
        ],
      ]);
    } finally {
      proxy.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        proxy.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it('keeps a streamed tunnel open for the consumer and closes it on cancellation', async () => {
    const transport = new GeminiHttpTransport();
    const closed = Promise.withResolvers<void>();
    const sockets = new Set<Duplex>();
    const origin = http.createServer((request, response) => {
      request.resume();
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.write('data: first\n\n');
    });
    const proxy = http.createServer();
    const controller = new AbortController();
    origin.listen(0, '127.0.0.1');
    proxy.listen(0, '127.0.0.1');
    try {
      await Promise.all([once(origin, 'listening'), once(proxy, 'listening')]);
      const originAddress = origin.address();
      const proxyAddress = proxy.address();
      if (
        !originAddress ||
        typeof originAddress === 'string' ||
        !proxyAddress ||
        typeof proxyAddress === 'string'
      ) {
        throw new Error('Expected two loopback listeners');
      }
      proxy.on('connect', (_request, socket, head) => {
        const upstream = connect(originAddress.port, '127.0.0.1');
        sockets.add(socket);
        sockets.add(upstream);
        socket.once('close', () => {
          upstream.destroy();
          closed.resolve();
        });
        upstream.once('error', () => socket.destroy());
        socket.once('error', () => upstream.destroy());
        upstream.once('connect', () => {
          socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
          upstream.write(head);
          socket.pipe(upstream).pipe(socket);
        });
      });

      const response = await transport.post<NodeJS.ReadableStream>(
        `http://127.0.0.1:${originAddress.port}/stream`,
        {},
        {
          proxy: { host: '127.0.0.1', port: proxyAddress.port },
          responseType: 'stream',
          signal: controller.signal,
        },
      );
      const [chunk] = await once(response.data, 'data');
      expect(String(chunk)).toBe('data: first\n\n');
      const streamClosed = Promise.withResolvers<void>();
      response.data.once('error', () => undefined);
      response.data.once('close', streamClosed.resolve);
      controller.abort();
      await Promise.all([streamClosed.promise, closed.promise]);
    } finally {
      transport.close();
      controller.abort();
      for (const socket of sockets) {
        socket.destroy();
      }
      origin.closeAllConnections();
      proxy.closeAllConnections();
      await Promise.all(
        [origin, proxy].map(
          (server) => new Promise<void>((resolve) => server.close(() => resolve())),
        ),
      );
    }
  });

  it('bounds a pending CONNECT before Axios receives a socket', async () => {
    const transport = new GeminiHttpTransport();
    const sockets = new Set<Duplex>();
    const closed = Promise.withResolvers<void>();
    const proxy = http.createServer();
    proxy.on('connect', (_request, socket) => {
      sockets.add(socket);
      socket.resume();
      socket.once('end', () => socket.end());
      socket.once('close', closed.resolve);
    });
    proxy.listen(0, '127.0.0.1');
    await once(proxy, 'listening');
    try {
      const address = proxy.address();
      if (!address || typeof address === 'string') {
        throw new Error('The synthetic proxy has no TCP port.');
      }
      await expect(
        transport.post(
          'https://example.invalid/stream',
          {},
          {
            proxy: { host: '127.0.0.1', port: address.port },
            timeout: 250,
          },
        ),
      ).rejects.toMatchObject({ code: 'ETIMEDOUT' });
      await closed.promise;
      expect(sockets.size).toBe(1);
    } finally {
      transport.close();
      for (const socket of sockets) {
        socket.destroy();
      }
      proxy.closeAllConnections();
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
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
