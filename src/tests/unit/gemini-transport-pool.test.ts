// @vitest-environment node
import http from 'node:http';
import { once } from 'node:events';
import { connect } from 'node:net';
import type { Duplex } from 'node:stream';
import { expect, it } from 'vitest';
import { GeminiHttpTransport } from '@/server/gateway/modules/gemini/gemini-http-transport';
import { GEMINI_TRANSPORT_LIMITS } from '@/server/gateway/modules/gemini/gemini-transport-pool';
import { UpstreamTransportCapacityError } from '@/server/gateway/common/exceptions/upstream-transport-capacity.exception';
import {
  createAccount,
  createGateway,
  createLease,
  createUpstream,
} from './proxy-real-path.harness';

async function fixture() {
  let originConnections = 0;
  const firstClosed = Promise.withResolvers<void>();
  const sockets = new Set<Duplex>();
  const tunnels: Array<string | undefined> = [];
  const origin = http.createServer((request, response) => {
    request.resume();
    response.writeHead(200, { 'Content-Type': 'application/json' });
    if (request.url === '/stream') {
      response.write('{"ok":true}');
    } else {
      response.end('{"ok":true}');
    }
  });
  const proxy = http.createServer();
  origin.on('connection', (socket) => {
    originConnections++;
    sockets.add(socket);
  });
  proxy.on('connection', (socket) => sockets.add(socket));
  origin.listen(0, '127.0.0.1');
  proxy.listen(0, '127.0.0.1');
  await Promise.all([once(origin, 'listening'), once(proxy, 'listening')]);
  const originAddress = origin.address();
  const proxyAddress = proxy.address();
  if (
    !originAddress ||
    typeof originAddress === 'string' ||
    !proxyAddress ||
    typeof proxyAddress === 'string'
  ) {
    throw new Error('Expected loopback listeners');
  }
  proxy.on('connect', (request, socket, head) => {
    tunnels.push(request.headers['proxy-authorization']);
    const upstream = connect(originAddress.port, '127.0.0.1');
    sockets.add(upstream);
    socket.once('close', () => upstream.destroy());
    socket.once('close', firstClosed.resolve);
    socket.once('error', () => upstream.destroy());
    upstream.once('error', () => socket.destroy());
    upstream.once('connect', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
  });
  return {
    url: `http://127.0.0.1:${originAddress.port}/generate`,
    proxy: { host: '127.0.0.1', port: proxyAddress.port, protocol: 'http' },
    tunnels,
    connections: () => originConnections,
    firstClosed: firstClosed.promise,
    async close() {
      for (const socket of sockets) {
        socket.destroy();
      }
      await Promise.all(
        [origin, proxy].map(
          (server) => new Promise<void>((resolve) => server.close(() => resolve())),
        ),
      );
    },
  };
}

it('reuses a completed upstream tunnel for the next request', async () => {
  const server = await fixture();
  const transport = new GeminiHttpTransport();
  try {
    for (let index = 0; index < 2; index++) {
      const response = await transport.post(server.url, {}, { proxy: server.proxy });
      expect(response.data).toEqual({ ok: true });
    }
    expect(server.tunnels).toHaveLength(1);
  } finally {
    transport.close();
    await server.close();
  }
});

it('keeps a reused connection independent of an earlier request cancellation', async () => {
  const server = await fixture();
  const transport = new GeminiHttpTransport();
  const controller = new AbortController();
  try {
    await transport.post(server.url, {}, { proxy: server.proxy, signal: controller.signal });
    controller.abort();
    const result = await transport.post(server.url, {}, { proxy: server.proxy });
    expect(result.data).toEqual({ ok: true });
    expect(server.tunnels).toHaveLength(1);
  } finally {
    transport.close();
    await server.close();
  }
});

it('preserves busy streams when capacity is exhausted and admits work after release', async () => {
  const server = await fixture();
  const transport = new GeminiHttpTransport({ ...GEMINI_TRANSPORT_LIMITS, maxRequests: 1 });
  try {
    const first = await transport.post<Duplex>(
      server.url.replace('/generate', '/stream'),
      {},
      {
        proxy: server.proxy,
        responseType: 'stream',
      },
    );
    let admitted = false;
    await expect(
      transport.post(server.url, {}, { proxy: server.proxy }, () => {
        admitted = true;
      }),
    ).rejects.toBeInstanceOf(UpstreamTransportCapacityError);
    expect(admitted).toBe(false);
    expect(first.data.destroyed).toBe(false);
    const closed = once(first.data, 'close');
    first.data.destroy();
    await closed;
    expect((await transport.post(server.url, {}, { proxy: server.proxy })).data).toEqual({
      ok: true,
    });
  } finally {
    transport.close();
    await server.close();
  }
});

it('isolates changed credentials while the earlier tunnel remains active', async () => {
  const server = await fixture();
  const transport = new GeminiHttpTransport();
  try {
    const first = await transport.post<Duplex>(
      server.url.replace('/generate', '/stream'),
      {},
      {
        proxy: { ...server.proxy, auth: { username: 'fixture', password: 'first' } },
        responseType: 'stream',
      },
    );
    await transport.post(
      server.url,
      {},
      {
        proxy: { ...server.proxy, auth: { username: 'fixture', password: 'second' } },
      },
    );
    expect(first.data.destroyed).toBe(false);
    expect(server.tunnels).toEqual([
      `Basic ${Buffer.from('fixture:first').toString('base64')}`,
      `Basic ${Buffer.from('fixture:second').toString('base64')}`,
    ]);
    first.data.destroy();
  } finally {
    transport.close();
    await server.close();
  }
});

it('bounds proxy identities without evicting a busy tunnel', async () => {
  const server = await fixture();
  const transport = new GeminiHttpTransport({ ...GEMINI_TRANSPORT_LIMITS, maxEntries: 1 });
  try {
    const first = await transport.post<Duplex>(
      server.url.replace('/generate', '/stream'),
      {},
      {
        proxy: server.proxy,
        responseType: 'stream',
      },
    );
    const changed = { ...server.proxy, auth: { username: 'fixture', password: 'changed' } };
    await expect(transport.post(server.url, {}, { proxy: changed })).rejects.toBeInstanceOf(
      UpstreamTransportCapacityError,
    );
    expect(first.data.destroyed).toBe(false);
    const closed = once(first.data, 'close');
    first.data.destroy();
    await closed;
    expect((await transport.post(server.url, {}, { proxy: changed })).data).toEqual({ ok: true });
    expect(server.tunnels).toHaveLength(2);
  } finally {
    transport.close();
    await server.close();
  }
});

it('expires an idle tunnel before accepting the next request', async () => {
  const server = await fixture();
  const transport = new GeminiHttpTransport({ ...GEMINI_TRANSPORT_LIMITS, idleMs: 40 });
  try {
    await transport.post(server.url, {}, { proxy: server.proxy });
    await server.firstClosed;
    await transport.post(server.url, {}, { proxy: server.proxy });
    expect(server.tunnels).toHaveLength(2);
  } finally {
    transport.close();
    await server.close();
  }
});

it('returns local capacity failure without another account attempt or penalty', async () => {
  const failure = new UpstreamTransportCapacityError();
  const upstream = createUpstream({
    generate: () => {
      throw failure;
    },
  });
  const lease = createLease([createAccount('first'), createAccount('second')]);
  const service = createGateway(upstream, lease).openAIService;
  await expect(
    service.handleChatCompletions({
      model: 'gemini-3-flash',
      messages: [{ role: 'user', content: 'Controlled capacity failure.' }],
    }),
  ).rejects.toBe(failure);
  expect(upstream.calls).toHaveLength(1);
  expect(lease.penalties).toEqual([]);
});

it('reuses direct connections and rejects work after transport shutdown', async () => {
  const server = await fixture();
  const transport = new GeminiHttpTransport();
  try {
    await transport.post(server.url, {}, { proxy: false });
    await transport.post(server.url, {}, { proxy: false });
    expect(server.tunnels).toEqual([]);
    expect(server.connections()).toBe(1);
    transport.close();
    await expect(transport.post(server.url, {}, { proxy: false })).rejects.toBeInstanceOf(
      UpstreamTransportCapacityError,
    );
  } finally {
    transport.close();
    await server.close();
  }
});

it('closes active tunneled streams during owner shutdown', async () => {
  const server = await fixture();
  const transport = new GeminiHttpTransport();
  try {
    const response = await transport.post<Duplex>(
      server.url.replace('/generate', '/stream'),
      {},
      {
        proxy: server.proxy,
        responseType: 'stream',
      },
    );
    const closed = new Promise<void>((resolve) => {
      response.data.once('error', () => undefined);
      response.data.once('close', resolve);
    });
    transport.close();
    await closed;
    expect(response.data.destroyed).toBe(true);
  } finally {
    transport.close();
    await server.close();
  }
});

it('cancels one active stream without closing another stream on the same proxy', async () => {
  const server = await fixture();
  const transport = new GeminiHttpTransport();
  const controller = new AbortController();
  try {
    const first = await transport.post<Duplex>(
      server.url.replace('/generate', '/stream'),
      {},
      {
        proxy: server.proxy,
        responseType: 'stream',
        signal: controller.signal,
      },
    );
    const second = await transport.post<Duplex>(
      server.url.replace('/generate', '/stream'),
      {},
      {
        proxy: server.proxy,
        responseType: 'stream',
      },
    );
    const closed = new Promise<void>((resolve) => {
      first.data.once('error', () => undefined);
      first.data.once('close', resolve);
    });
    controller.abort();
    await closed;
    expect(second.data.destroyed).toBe(false);
    expect(server.tunnels).toHaveLength(2);
    second.data.destroy();
  } finally {
    transport.close();
    await server.close();
  }
});
