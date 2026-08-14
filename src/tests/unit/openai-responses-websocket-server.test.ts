import { createServer } from 'node:http';

import { Observable } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';

import { attachOpenAIResponsesWebSocketServer } from '@/modules/proxy-gateway/server/modules/openai/responses/openai-responses-websocket.server';

describe('OpenAI Responses WebSocket server', () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    while (cleanups.length > 0) {
      cleanups.pop()?.();
    }
  });

  it('does not subscribe when the socket closes before streamRequest resolves', async () => {
    const server = createServer();
    let resolveStream!: (stream: Observable<unknown>) => void;
    const streamRequest = vi.fn(
      () =>
        new Promise<Observable<unknown>>((resolve) => {
          resolveStream = resolve;
        }),
    );
    const subscribeSpy = vi.fn();
    const detach = attachOpenAIResponsesWebSocketServer(server, {
      isAuthorized: () => true,
      streamRequest,
    });

    cleanups.push(detach);
    cleanups.push(() => server.close());

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Expected TCP server address');
    }

    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/v1/responses`);
    cleanups.push(() => socket.terminate());
    await new Promise<void>((resolve) => socket.once('open', resolve));

    socket.send(JSON.stringify({ type: 'response.create', model: 'gemini-test' }));
    await vi.waitFor(() => expect(streamRequest).toHaveBeenCalledTimes(1));

    socket.close();
    await new Promise<void>((resolve) => socket.once('close', resolve));

    resolveStream(
      new Observable(() => {
        subscribeSpy();
      }),
    );

    await new Promise((resolve) => setImmediate(resolve));
    expect(subscribeSpy).not.toHaveBeenCalled();
  });
});
