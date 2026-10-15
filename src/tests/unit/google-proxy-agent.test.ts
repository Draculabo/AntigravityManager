import http from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { UpstreamProxyConfigurationError } from '@/modules/config/upstream-proxy.schema';
import { createGoogleProxyAgent } from '@/modules/cloud-account/services/google-proxy-agent';

afterEach(() => vi.unstubAllEnvs());

describe('Google CONNECT proxy transport', () => {
  it('closes a pending CONNECT socket when the request is cancelled', async () => {
    const connected = Promise.withResolvers<void>();
    const closed = Promise.withResolvers<void>();
    const sockets = new Set<import('node:stream').Duplex>();
    const proxy = http.createServer();
    proxy.on('connect', (_request, socket) => {
      sockets.add(socket);
      socket.resume();
      socket.on('end', () => socket.end());
      socket.on('close', () => {
        sockets.delete(socket);
        closed.resolve();
      });
      connected.resolve();
    });
    await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
    const address = proxy.address();
    if (!address || typeof address === 'string') {
      throw new Error('Synthetic proxy has no port');
    }
    const controller = new AbortController();
    const agent = createGoogleProxyAgent(
      'https://example.invalid/token',
      { host: '127.0.0.1', port: address.port, protocol: 'http' },
      controller.signal,
    );
    try {
      const request = axios
        .get('https://example.invalid/token', {
          adapter: 'http',
          proxy: false,
          httpsAgent: agent,
          signal: controller.signal,
        })
        .catch((error: unknown) => error);
      await connected.promise;
      controller.abort();
      expect(axios.isCancel(await request)).toBe(true);
      expect(
        await Promise.race([closed.promise.then(() => 'closed'), delay(1000).then(() => 'open')]),
      ).toBe('closed');
    } finally {
      controller.abort();
      agent?.destroy();
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
    }
  });

  it('honors NO_PROXY for environment routing while an explicit proxy remains authoritative', () => {
    vi.stubEnv('https_proxy', 'http://127.0.0.1:7897');
    vi.stubEnv('no_proxy', 'example.invalid');
    vi.stubEnv('npm_config_no_proxy', '');
    vi.stubEnv('npm_config_https_proxy', '');
    expect(createGoogleProxyAgent('https://example.invalid/token')).toBeUndefined();
    const agent = createGoogleProxyAgent('https://example.invalid/token', {
      host: '127.0.0.1',
      port: 7898,
      protocol: 'http',
    });
    try {
      expect(agent?.proxy.href).toBe('http://127.0.0.1:7898/');
    } finally {
      agent?.destroy();
    }
  });
  it.each(['socks5://127.0.0.1:7897', 'http://user:%ZZ@127.0.0.1:7897'])(
    'rejects invalid environment proxy input before connecting: %s',
    (url) => {
      vi.stubEnv('https_proxy', url);
      vi.stubEnv('no_proxy', '');
      vi.stubEnv('NO_PROXY', '');
      vi.stubEnv('npm_config_no_proxy', '');
      vi.stubEnv('npm_config_https_proxy', '');
      expect(() => createGoogleProxyAgent('https://example.invalid/token')).toThrow(
        UpstreamProxyConfigurationError,
      );
    },
  );
});
