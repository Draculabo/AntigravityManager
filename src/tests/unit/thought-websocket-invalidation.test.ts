import { createServer } from 'node:http';
import { WebSocket } from 'ws';
import { Subject } from 'rxjs';
import { expect, it, vi } from 'vitest';
import { attachOpenAIResponsesWebSocketServer } from '@/server/gateway/modules/openai/responses/openai-responses-websocket.server';
import { OpenAIResponsesSessionService } from '@/server/gateway/modules/openai/responses/openai-responses-session.service';
import { createThoughtSessionKey } from '@/modules/proxy-gateway/audit/traffic-audit-http-metadata';
import { getTrafficAuditRequestContext } from '@/modules/proxy-gateway/audit/traffic-audit-context';
import { thoughtCaptureLeases } from '@/modules/proxy-gateway/thought-store/thought-capture-leases';
import { invalidateThoughtRecoveryPeers } from '@/modules/proxy-gateway/thought-store/thought-recovery-peers';

it('clears the exact live socket transcript, rejects late completion recovery and preserves a neighboring connection', async () => {
  const baseline = thoughtCaptureLeases.protectedKeys();
  const calls: Array<{ key: string; input: unknown; stream: Subject<unknown> }> = [];
  const server = createServer();
  const detach = attachOpenAIResponsesWebSocketServer(server, {
    isAuthorized: () => true,
    streamRequest: async (request) => {
      const context = getTrafficAuditRequestContext();
      expect(context?.thoughtCaptureLease?.valid).toBe(true);
      const stream = new Subject<unknown>();
      calls.push({ key: context!.thoughtSessionKey, input: request.input, stream });
      return stream;
    },
  });
  const owner = new OpenAIResponsesSessionService({});
  owner.onModuleInit();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Expected isolated TCP server');
  }
  const connect = async (id: string) => {
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/v1/responses`, {
      headers: { 'x-session-id': id },
    });
    const events: unknown[] = [];
    socket.on('message', (data) => {
      events.push(JSON.parse(data.toString()));
    });
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    return { socket, events };
  };
  const first = await connect('client-A');
  const second = await connect('client-B');
  try {
    const begin = (socket: WebSocket) =>
      socket.send(
        JSON.stringify({
          type: 'response.create',
          model: 'fixture',
          input: [{ role: 'user', content: 'original' }],
        }),
      );
    begin(first.socket);
    begin(second.socket);
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    const keyA = createThoughtSessionKey({}, 'client-A');
    const callA = calls.find((call) => call.key === keyA)!;
    const callB = calls.find((call) => call.key !== keyA)!;
    callB.stream.next({
      type: 'response.completed',
      response: { id: 'B', output: [{ role: 'assistant', content: 'B output' }] },
    });
    callB.stream.complete();
    await vi.waitFor(() => expect(second.events).toHaveLength(1));
    const release = thoughtCaptureLeases.block(keyA);
    try {
      const receipt = await invalidateThoughtRecoveryPeers(keyA);
      expect(receipt.recovery.find((effect) => effect.owner === 'responses')).toEqual({
        owner: 'responses',
        state: 'complete',
        removed: 1,
        unknown: 0,
      });
      callA.stream.next({
        type: 'response.completed',
        response: { id: 'late-A', output: [{ role: 'assistant', content: 'deleted output' }] },
      });
      callA.stream.complete();
      await vi.waitFor(() => expect(first.events).toHaveLength(2));
    } finally {
      release();
    }
    first.socket.send(
      JSON.stringify({ type: 'response.append', input: [{ role: 'user', content: 'next' }] }),
    );
    await vi.waitFor(() => expect(first.events).toHaveLength(3));
    expect(first.events.at(-1)).toMatchObject({ type: 'error' });
    expect(calls).toHaveLength(2);
    second.socket.send(
      JSON.stringify({ type: 'response.append', input: [{ role: 'user', content: 'next' }] }),
    );
    await vi.waitFor(() => expect(calls).toHaveLength(3));
    expect(calls[2].input).toEqual([
      { role: 'user', content: 'original' },
      { role: 'assistant', content: 'B output' },
      { role: 'user', content: 'next' },
    ]);
    calls[2].stream.complete();
    begin(first.socket);
    await vi.waitFor(() => expect(calls).toHaveLength(4));
    expect(calls[3].input).toEqual([{ role: 'user', content: 'original' }]);
    calls[3].stream.complete();
  } finally {
    first.socket.terminate();
    second.socket.terminate();
    for (const call of calls) {
      call.stream.complete();
    }
    detach();
    owner.onModuleDestroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  await vi.waitFor(() => expect(thoughtCaptureLeases.protectedKeys()).toEqual(baseline));
});
