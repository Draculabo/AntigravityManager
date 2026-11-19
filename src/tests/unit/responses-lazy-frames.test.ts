import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  createLazySseStream,
  FlowControlledSseStream,
} from '@/server/gateway/common/flow-controlled-sse-stream';
import { createResponsesStream } from '@/server/gateway/modules/openai/responses/openai-responses-stream';
import { createSyntheticResponsesStream } from '@/server/gateway/modules/openai/openai-synthetic-streams';
import type { GeminiPart } from '@/modules/proxy-gateway/antigravity/types';

const eventSchema = z.object({ type: z.string(), sequence_number: z.number() }).passthrough();
function parse(frame: string) {
  return eventSchema.parse(JSON.parse(frame.slice(frame.indexOf('data: ') + 6)));
}
function createLiveStream(source: PassThrough) {
  return createResponsesStream(
    source,
    { model: 'fixture', responseId: 'resp_fixture' },
    {
      requiresCleanImageEnd: false,
      markImageSuccess: vi.fn(),
      release: vi.fn(),
      logError: vi.fn(),
      createIdleTimer: () => ({ reset: vi.fn(), clear: vi.fn() }),
    },
  );
}
function observeSerialization() {
  const types: string[] = [];
  const stringify = JSON.stringify;
  const spy = vi.spyOn(JSON, 'stringify').mockImplementation((value, ...args) => {
    if (
      value &&
      typeof value === 'object' &&
      typeof Reflect.get(value, 'type') === 'string' &&
      typeof Reflect.get(value, 'sequence_number') === 'number'
    ) {
      types.push(Reflect.get(value, 'type'));
    }
    return stringify(value, ...args);
  });
  return { types, restore: () => spy.mockRestore() };
}

describe('Responses frame demand', () => {
  it('does not invoke a cancelled factory and routes a live factory error to the subscriber', async () => {
    const failure = new Error('fixture factory failed');
    const generate = vi.fn((): Iterable<string> => {
      throw failure;
    });
    const cancelled = createLazySseStream(generate).subscribe();
    cancelled.unsubscribe();
    await Promise.resolve();
    expect(generate).not.toHaveBeenCalled();
    const error = vi.fn();
    createLazySseStream(generate).subscribe({ error });
    await Promise.resolve();
    expect(error.mock.calls).toEqual([[failure]]);
    expect(generate).toHaveBeenCalledOnce();
  });
  it('does not prefetch a synthetic frame while paused and closes on cancellation', async () => {
    let generated = 0;
    let closed = false;
    const stream = createLazySseStream(function* () {
      try {
        for (let i = 0; i < 10; i++) {
          generated++;
          yield String(i);
        }
      } finally {
        closed = true;
      }
    });
    const received: string[] = [];
    const subscription = stream.subscribe((value) => {
      received.push(value);
      stream.pause();
    });
    await Promise.resolve();
    expect({ generated, received }).toEqual({ generated: 1, received: ['0'] });
    stream.resume();
    expect({ generated, received }).toEqual({ generated: 2, received: ['0', '1'] });
    subscription.unsubscribe();
    stream.resume();
    expect({ generated, closed }).toEqual({ generated: 2, closed: true });
  });

  it.each([
    { part: { text: 'Answer 😀' }, delta: 'response.output_text.delta' },
    { part: { text: 'Reason 😀', thought: true }, delta: 'response.reasoning_summary_text.delta' },
    {
      part: { functionCall: { args: { query: 'fixture' }, id: 'call_fixture', name: 'search' } },
      delta: 'response.function_call_arguments.delta',
    },
  ] satisfies Array<{ part: GeminiPart; delta: string }>)(
    'serializes only the requested frame for $delta, including same-event completion',
    async ({ part, delta }) => {
      const source = new PassThrough();
      const stream = createLiveStream(source);
      const serialization = observeSerialization();
      const frames: string[] = [];
      let complete = false;
      const subscription = stream.subscribe({
        next: (frame) => {
          frames.push(frame);
          stream.pause();
        },
        complete: () => {
          complete = true;
        },
      });
      expect(frames.map(parse).map((event) => event.type)).toEqual(['response.created']);
      source.end(
        'data: ' +
          JSON.stringify({
            response: { candidates: [{ content: { parts: [part] }, finishReason: 'STOP' }] },
          }) +
          '\n\n',
      );
      try {
        for (let i = 0; i < 30 && !complete; i++) {
          await new Promise((resolve) => setImmediate(resolve));
          expect(serialization.types).toEqual(frames.map((frame) => parse(frame).type));
          if (!complete) {
            expect(stream.isPaused).toBe(true);
          }
          const previousCount = frames.length;
          stream.resume();
          await new Promise((resolve) => setImmediate(resolve));
          expect(frames.length - previousCount).toBeLessThanOrEqual(1);
        }
        expect(complete).toBe(true);
        const events = frames.map(parse);
        expect(events.map((event) => event.sequence_number)).toEqual(events.map((_, i) => i));
        expect(events.some((event) => event.type === delta)).toBe(true);
        const thoughtOnly = 'thought' in part && part.thought === true;
        expect(events.at(-1)).toMatchObject({
          type: thoughtOnly ? 'response.failed' : 'response.completed',
          response: {
            status: thoughtOnly ? 'failed' : 'completed',
            ...(thoughtOnly ? { error: { code: 'empty_thinking_response' } } : {}),
          },
        });
        expect(source.destroyed).toBe(true);
      } finally {
        subscription.unsubscribe();
        serialization.restore();
      }
    },
  );

  it('stops before constructing full-text termination frames on disconnect', async () => {
    const source = new PassThrough();
    const stream = createLiveStream(source);
    const serialization = observeSerialization();
    const subscription = stream.subscribe((frame) => {
      if (parse(frame).type === 'response.output_text.delta') {
        stream.pause();
      }
    });
    source.end(
      'data: ' +
        JSON.stringify({
          response: {
            candidates: [
              { content: { parts: [{ text: 'x'.repeat(64 * 1024) }] }, finishReason: 'STOP' },
            ],
          },
        }) +
        '\n\n',
    );
    try {
      await vi.waitFor(() => expect(stream.isPaused).toBe(true));
      subscription.unsubscribe();
      stream.resume();
      expect(serialization.types).toEqual([
        'response.created',
        'response.in_progress',
        'response.output_item.added',
        'response.content_part.added',
        'response.output_text.delta',
      ]);
      expect(source.destroyed).toBe(true);
      expect(source.listenerCount('data')).toBe(0);
    } finally {
      subscription.unsubscribe();
      serialization.restore();
    }
  });

  it('replaces a suspended input iterator with lazy failure finalization', async () => {
    const source = new PassThrough();
    const stream = createLiveStream(source);
    const frames: string[] = [];
    let completed = false;
    const subscription = stream.subscribe({
      next: (frame) => {
        frames.push(frame);
        if (parse(frame).type === 'response.output_text.delta') {
          stream.pause();
        }
      },
      complete: () => {
        completed = true;
      },
    });
    source.write(
      'data: ' +
        JSON.stringify({
          response: {
            candidates: [
              { content: { parts: [{ text: 'partial' }, { text: 'must not follow failure' }] } },
            ],
          },
        }) +
        '\n\n',
    );
    try {
      await vi.waitFor(() => expect(stream.isPaused).toBe(true));
      source.emit('error', new Error('fixture interruption'));
      expect(completed).toBe(false);
      stream.resume();
      const events = frames.map(parse);
      expect(
        events
          .filter((event) => event.type === 'response.output_text.delta')
          .map((event) => event.delta),
      ).toEqual(['partial']);
      expect(events.at(-1)).toMatchObject({
        type: 'response.failed',
        response: { status: 'failed', error: { code: 'upstream_stream_error' } },
      });
      expect(completed).toBe(true);
      expect(source.destroyed).toBe(true);
    } finally {
      subscription.unsubscribe();
    }
  });

  it('still fails EOF without a finish reason after paused output drains', async () => {
    const source = new PassThrough();
    const stream = createLiveStream(source);
    const frames: string[] = [];
    let completed = false;
    const subscription = stream.subscribe({
      next: (frame) => {
        frames.push(frame);
        stream.pause();
      },
      complete: () => {
        completed = true;
      },
    });
    source.end(
      'data: ' +
        JSON.stringify({
          response: { candidates: [{ content: { parts: [{ text: 'partial without finish' }] } }] },
        }) +
        '\n\n',
    );
    try {
      for (let index = 0; index < 30 && !completed; index += 1) {
        stream.resume();
        await new Promise((resolve) => setImmediate(resolve));
      }
      expect(completed).toBe(true);
      const events = frames.map(parse);
      expect(events.filter((event) => event.type === 'response.failed')).toHaveLength(1);
      expect(events.some((event) => event.type === 'response.completed')).toBe(false);
      expect(
        events
          .filter((event) => event.type === 'response.output_text.delta')
          .map((event) => event.delta),
      ).toEqual(['partial without finish']);
      expect(events.at(-1)).toMatchObject({
        type: 'response.failed',
        response: { error: { code: 'upstream_interrupted' }, status: 'failed' },
      });
      expect(source.destroyed).toBe(true);
    } finally {
      subscription.unsubscribe();
    }
  });

  it('applies exact frame demand to full-text synthetic finalization', async () => {
    const stream = createSyntheticResponsesStream({
      id: 'chat_fixture',
      created: 1,
      model: 'fixture',
      object: 'chat.completion',
      choices: [
        { index: 0, message: { role: 'assistant', content: 'Answer 😀' }, finish_reason: 'stop' },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
    });
    if (!(stream instanceof FlowControlledSseStream)) {
      throw new Error('Expected controlled synthetic stream');
    }
    const serialization = observeSerialization();
    const frames: string[] = [];
    const subscription = stream.subscribe((frame) => {
      frames.push(frame);
      stream.pause();
    });
    try {
      await Promise.resolve();
      for (let i = 0; i < 9; i++) {
        expect(serialization.types).toEqual(frames.map((frame) => parse(frame).type));
        stream.resume();
      }
      expect(subscription.closed).toBe(true);
      expect(frames.map(parse).at(-1)).toMatchObject({
        type: 'response.completed',
        response: { usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 } },
      });
    } finally {
      subscription.unsubscribe();
      serialization.restore();
    }
  });
});
