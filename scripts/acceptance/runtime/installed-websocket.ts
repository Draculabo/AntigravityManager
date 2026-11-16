import assert from 'node:assert/strict';
import { on, once } from 'node:events';
import { WebSocket, WebSocketServer } from 'ws';
import { z } from 'zod';

const prewarmEvent = z.object({
  type: z.enum(['response.created', 'response.completed']),
  sequence_number: z.number(),
  response: z.object({
    id: z.string().startsWith('resp_prewarm_'),
    model: z.literal('acceptance-model'),
    status: z.enum(['in_progress', 'completed']),
    output: z.array(z.unknown()).length(0),
  }),
});

export async function verifyInstalledWebSocket(port: number, apiKey: string): Promise<void> {
  const endpoint = `ws://127.0.0.1:${port}/v1/responses`;
  const denied = new WebSocket(endpoint, { handshakeTimeout: 10_000 });
  try {
    const [, response] = await once(denied, 'unexpected-response', {
      signal: AbortSignal.timeout(10_000),
    });
    assert.equal(response.statusCode, 401);
    response.resume();
  } finally {
    denied.on('error', () => undefined);
    denied.terminate();
  }

  const socket = new WebSocket(endpoint, {
    headers: { Authorization: `Bearer ${apiKey}` },
    handshakeTimeout: 10_000,
  });
  const messages = on(socket, 'message', { signal: AbortSignal.timeout(10_000) });
  try {
    await once(socket, 'open', { signal: AbortSignal.timeout(10_000) });
    socket.send(
      JSON.stringify({
        type: 'response.create',
        generate: false,
        model: 'acceptance-model',
        input: [],
      }),
    );
    const events: z.infer<typeof prewarmEvent>[] = [];
    for await (const [data] of messages) {
      assert(Buffer.isBuffer(data));
      events.push(prewarmEvent.parse(JSON.parse(data.toString())));
      if (events.length === 2) {
        break;
      }
    }
    assert.deepEqual(
      events.map((event) => [event.type, event.sequence_number, event.response.status]),
      [
        ['response.created', 0, 'in_progress'],
        ['response.completed', 1, 'completed'],
      ],
    );
    assert.equal(events[0].response.id, events[1].response.id);
    const closed = once(socket, 'close', { signal: AbortSignal.timeout(10_000) });
    socket.close(1000);
    assert.equal((await closed)[0], 1000);
  } finally {
    await messages.return();
    socket.terminate();
  }

  const server = new WebSocketServer({ host: '127.0.0.1', port: 0, perMessageDeflate: true });
  let peer: WebSocket | undefined;
  server.on('connection', (connection) => {
    peer = connection;
    connection.on('message', (data, binary) => connection.send(data, { binary }));
  });
  try {
    await once(server, 'listening', { signal: AbortSignal.timeout(10_000) });
    const address = server.address();
    assert(address && typeof address !== 'string');
    const client = new WebSocket(`ws://127.0.0.1:${address.port}`, {
      perMessageDeflate: { threshold: 0 },
      handshakeTimeout: 10_000,
    });
    try {
      await once(client, 'open', { signal: AbortSignal.timeout(10_000) });
      assert.equal(client.extensions, 'permessage-deflate');
      const text = 'WebSocket compression \u4e2d\u6587 '.repeat(256);
      const received = once(client, 'message', { signal: AbortSignal.timeout(10_000) });
      client.send(text, { compress: true });
      const [data, binary] = await received;
      assert(Buffer.isBuffer(data));
      assert.equal(binary, false);
      assert.equal(data.toString(), text);
      const closed = once(client, 'close', { signal: AbortSignal.timeout(10_000) });
      client.close(1000);
      assert.equal((await closed)[0], 1000);
    } finally {
      client.terminate();
    }
  } finally {
    peer?.terminate();
    const closed = once(server, 'close', { signal: AbortSignal.timeout(10_000) });
    server.close();
    await closed;
  }
  process.stdout.write(
    'Installed WebSocket authentication, prewarm, compression and closure passed.\n',
  );
}
