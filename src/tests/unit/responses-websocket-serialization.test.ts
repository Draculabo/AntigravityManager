import { createServer } from 'node:http';
import { WebSocket } from 'ws';
import { describe, expect, it, vi } from 'vitest';
import { of, type Observable } from 'rxjs';
import { z } from 'zod';
import { FlowControlledSseStream } from '@/server/gateway/common/flow-controlled-sse-stream';
import { takeSerializedResponsesFrame } from '@/server/gateway/modules/openai/responses/serialized-responses-frames';
import { createSyntheticResponsesStream } from '@/server/gateway/modules/openai/openai-synthetic-streams';
import { attachOpenAIResponsesWebSocketServer } from '@/server/gateway/modules/openai/responses/openai-responses-websocket.server';
import { OpenAIResponsesWebSocketProtocol } from '@/server/gateway/modules/openai/responses/openai-responses-websocket.protocol';

it('sends owned Responses frames without parsing or serializing their JSON again', async () => {
  const server = createServer();
  const detach = attachOpenAIResponsesWebSocketServer(server, {
    isAuthorized: () => true,
    streamRequest: async () =>
      createSyntheticResponsesStream({
        id: 'fixture',
        object: 'chat.completion',
        created: 1,
        model: 'fixture',
        choices: [
          {
            index: 0,
            finish_reason: 'stop',
            message: { role: 'assistant', content: 'x'.repeat(32 * 1024) + '😀\n"世界' },
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Expected TCP address');
  }
  const eventTypes = [
    'response.created',
    'response.in_progress',
    'response.output_item.added',
    'response.content_part.added',
    'response.output_text.delta',
    'response.output_text.done',
    'response.content_part.done',
    'response.output_item.done',
    'response.completed',
  ];
  const originalStringify = JSON.stringify;
  const originalParse = JSON.parse;
  let serializations = 0;
  let reparses = 0;
  const stringify = vi.spyOn(JSON, 'stringify').mockImplementation((value, ...args) => {
    if (value && typeof value === 'object' && eventTypes.includes(Reflect.get(value, 'type'))) {
      serializations++;
    }
    return originalStringify(value, ...args);
  });
  const parse = vi.spyOn(JSON, 'parse').mockImplementation((value, ...args) => {
    const result: unknown = originalParse(value, ...args);
    if (result && typeof result === 'object' && eventTypes.includes(Reflect.get(result, 'type'))) {
      reparses++;
    }
    return result;
  });
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}/v1/responses`);
  try {
    const messages = await new Promise<string[]>((resolve, reject) => {
      const messages: string[] = [];
      socket.once('error', reject);
      socket.once('open', () =>
        socket.send(JSON.stringify({ type: 'response.create', model: 'fixture', input: [] })),
      );
      socket.on('message', (raw, binary) => {
        expect(binary).toBe(false);
        messages.push(raw.toString());
        if (messages.length === 9) {
          resolve(messages);
        }
      });
    });
    stringify.mockRestore();
    parse.mockRestore();
    expect(messages.map((message) => Reflect.get(JSON.parse(message), 'type'))).toEqual(eventTypes);
    expect({ serializations, reparses }).toEqual({ serializations: 9, reparses: 0 });
  } finally {
    stringify.mockRestore();
    parse.mockRestore();
    socket.terminate();
    detach();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

async function receive(stream: Observable<unknown>, count: number): Promise<unknown[]> {
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
  try {
    return await new Promise<unknown[]>((resolve, reject) => {
      const messages: unknown[] = [];
      socket.once('error', reject);
      socket.once('open', () =>
        socket.send(JSON.stringify({ type: 'response.create', model: 'fixture', input: [] })),
      );
      socket.on('message', (raw) => {
        messages.push(JSON.parse(raw.toString()));
        if (messages.length === count) {
          resolve(messages);
        }
      });
    });
  } finally {
    socket.terminate();
    detach();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

it('releases completed history when a closed connection context remains referenced', async () => {
  const contexts: OpenAIResponsesWebSocketProtocol[] = [];
  const complete = OpenAIResponsesWebSocketProtocol.prototype.complete;
  const capture = vi
    .spyOn(OpenAIResponsesWebSocketProtocol.prototype, 'complete')
    .mockImplementation(function (this: OpenAIResponsesWebSocketProtocol, response: unknown) {
      complete.call(this, response);
      contexts.push(this);
    });
  try {
    await receive(
      of({
        type: 'response.completed',
        response: {
          id: 'retained',
          output: [
            { type: 'message', content: [{ type: 'output_text', text: 'x'.repeat(64 * 1024) }] },
          ],
        },
      }),
      1,
    );
    await vi.waitFor(() => {
      expect(contexts).toHaveLength(1);
      expect(contexts[0]?.getPreviousResponseId()).toBe('');
    });
    expect(Reflect.get(contexts[0]!, 'lastResponseOutput')).toEqual([]);
    expect(Reflect.get(contexts[0]!, 'lastRequest')).toBeNull();
  } finally {
    capture.mockRestore();
  }
});
function synthetic() {
  return createSyntheticResponsesStream({
    id: 'fixture',
    object: 'chat.completion',
    created: 1,
    model: 'fixture',
    choices: [
      { index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'Answer 😀' } },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  });
}

describe('serialized Responses frame ownership', () => {
  it('keeps validation and normalization for unknown, fragmented and multiline JSON sources', async () => {
    const chunks = [
      'data: invalid\n\ndata: [DONE]\n\ndata: []\n\ndata: {"type":42}\n\n',
      'data: {"type":"response.output_text.delta",\r\n',
      'data: "delta":"😀\\n\\"世界","value":1e999,"negativeZero":-0}\r\n\r\n',
      { type: 'response.completed', response: { id: 'unknown', output: [], status: 'completed' } },
    ];
    expect(await receive(of(...chunks), 2)).toEqual([
      { type: 'response.output_text.delta', delta: '😀\n"世界', value: null, negativeZero: 0 },
      { type: 'response.completed', response: { id: 'unknown', output: [], status: 'completed' } },
    ]);
  });

  it('does not propagate canonical ownership through a wrapper that modifies event bytes', async () => {
    const source = synthetic();
    if (!(source instanceof FlowControlledSseStream)) {
      throw new Error('Expected controlled stream');
    }
    const wrapped = new FlowControlledSseStream(source, (subscriber) =>
      source.subscribe({
        next: (frame) => subscriber.next(frame.replace('Answer 😀', 'Changed 😀')),
        complete: () => subscriber.complete(),
        error: (error) => subscriber.error(error),
      }),
    );
    const events = await receive(wrapped, 9);
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'response.output_text.delta', delta: 'Changed 😀' }),
    );
  });

  it('drops the canonical full-text frame on cancellation and normal completion', async () => {
    const source = synthetic();
    if (!(source instanceof FlowControlledSseStream)) {
      throw new Error('Expected controlled stream');
    }
    let pending = '';
    const subscription = source.subscribe((frame) => {
      if (frame.startsWith('event: response.output_text.delta\n')) {
        pending = frame;
        source.pause();
      }
    });
    await Promise.resolve();
    expect(pending).not.toBe('');
    subscription.unsubscribe();
    expect(takeSerializedResponsesFrame(source, pending)).toBeUndefined();
    const completeSource = synthetic();
    let last = '';
    await new Promise<void>((resolve, reject) =>
      completeSource.subscribe({
        next: (frame) => {
          last = frame;
        },
        complete: resolve,
        error: reject,
      }),
    );
    expect(last).toContain('response.completed');
    expect(takeSerializedResponsesFrame(completeSource, last)).toBeUndefined();
  });

  it('retains the completed tool transcript when the next request appends a result', async () => {
    const requests: Array<Record<string, unknown>> = [];
    const server = createServer();
    const detach = attachOpenAIResponsesWebSocketServer(server, {
      isAuthorized: () => true,
      streamRequest: async (request) => {
        requests.push(request);
        if (requests.length > 1) {
          return synthetic();
        }
        return createSyntheticResponsesStream({
          id: 'fixture',
          object: 'chat.completion',
          created: 1,
          model: 'fixture',
          choices: [
            {
              index: 0,
              finish_reason: 'tool_calls',
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [
                  {
                    id: 'call_fixture',
                    type: 'function',
                    function: { name: 'search', arguments: '{"query":"fixture"}' },
                  },
                ],
              },
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        });
      },
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Expected TCP address');
    }
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/v1/responses`);
    const input = [{ type: 'message', role: 'user', content: 'fixture' }];
    const result = { type: 'function_call_output', call_id: 'call_fixture', output: 'result' };
    let completed = 0;
    let output: unknown[] = [];
    const eventSchema = z.object({
      type: z.string(),
      response: z.object({ id: z.string(), output: z.array(z.unknown()) }).optional(),
    });
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once('error', reject);
        socket.once('open', () =>
          socket.send(JSON.stringify({ type: 'response.create', model: 'fixture', input })),
        );
        socket.on('message', (raw) => {
          const event = eventSchema.parse(JSON.parse(raw.toString()));
          if (event.type === 'response.completed') {
            completed++;
            if (completed === 1) {
              output = event.response?.output ?? [];
              socket.send(JSON.stringify({ type: 'response.append', input: [result] }));
            } else {
              resolve();
            }
          }
        });
      });
      expect(requests).toEqual([
        { model: 'fixture', stream: true, input },
        { model: 'fixture', stream: true, input: [...input, ...output, result] },
      ]);
    } finally {
      socket.terminate();
      detach();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
