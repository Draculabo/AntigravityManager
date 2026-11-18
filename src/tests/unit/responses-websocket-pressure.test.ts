import { createServer } from 'node:http';
import { PassThrough } from 'node:stream';
import { WebSocket } from 'ws';
import { describe, expect, it, vi } from 'vitest';
import { FlowControlledSseStream } from '@/server/gateway/common/flow-controlled-sse-stream';
import { attachOpenAIResponsesWebSocketServer } from '@/server/gateway/modules/openai/responses/openai-responses-websocket.server';

describe('Responses WebSocket pressure', () => {
  it('aborts admission on disconnect and destroys a late unconsumed Readable', async () => {
    const source = new PassThrough();
    const stream = new FlowControlledSseStream(source, () => {});
    let deliver: ((stream: FlowControlledSseStream) => void) | undefined;
    let signal: AbortSignal | undefined;
    const server = createServer();
    const detach = attachOpenAIResponsesWebSocketServer(server, {
      isAuthorized: () => true,
      streamRequest: (_request, ownerSignal) => {
        signal = ownerSignal;
        return new Promise((resolve) => {
          deliver = resolve;
        });
      },
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Expected TCP address');
    }
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/v1/responses`);
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once('open', resolve);
        socket.once('error', reject);
      });
      socket.send(JSON.stringify({ type: 'response.create', model: 'fixture', input: [] }));
      await vi.waitFor(() => expect(deliver).toBeTypeOf('function'));
      socket.terminate();
      await vi.waitFor(() => expect(signal?.aborted).toBe(true));
      deliver?.(stream);
      await vi.waitFor(() => expect(source.destroyed).toBe(true));
    } finally {
      socket.terminate();
      source.destroy();
      detach();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
  it('holds upstream until the send callback and releases it on disconnect', async () => {
    const source = new PassThrough();
    let produced = 0;
    const released = vi.fn();
    const stream = new FlowControlledSseStream(source, (subscriber) => {
      const data = (chunk: Buffer) => {
        produced++;
        subscriber.next(chunk.toString());
      };
      source.on('data', data);
      return () => {
        source.off('data', data);
        source.destroy();
        released();
      };
    });
    const server = createServer();
    const detach = attachOpenAIResponsesWebSocketServer(server, {
      isAuthorized: () => true,
      streamRequest: async () => stream,
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Expected TCP address');
    }
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/v1/responses`);
    const original = WebSocket.prototype.send;
    let acknowledge: ((error?: Error) => void) | undefined;
    const send = vi.spyOn(WebSocket.prototype, 'send').mockImplementation(function (
      this: WebSocket,
      data,
      options,
      callback,
    ) {
      if (data.toString().includes('response.output_text.delta')) {
        acknowledge = typeof options === 'function' ? options : callback;
        return;
      }
      if (typeof options === 'function') {
        original.call(this, data, options);
      } else {
        original.call(this, data, options ?? {}, callback);
      }
    });
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once('open', resolve);
        socket.once('error', reject);
      });
      socket.send(JSON.stringify({ type: 'response.create', model: 'fixture', input: [] }));
      await vi.waitFor(() => expect(source.listenerCount('data')).toBe(1));
      source.write('data: {"type":"response.output_text.delta","delta":"first"}\n\n');
      expect(source.isPaused()).toBe(true);
      source.write('data: {"type":"response.output_text.delta","delta":"second"}\n\n');
      expect(produced).toBe(1);
      expect(acknowledge).toBeTypeOf('function');
      acknowledge?.();
      await vi.waitFor(() => expect(produced).toBe(2));
      socket.terminate();
      await vi.waitFor(() => expect(released).toHaveBeenCalledOnce());
    } finally {
      send.mockRestore();
      socket.terminate();
      detach();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
