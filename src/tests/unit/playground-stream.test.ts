// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  PLAYGROUND_STREAM_MAX_BYTES,
  PlaygroundStreamError,
  readPlaygroundStream,
} from '@/modules/proxy-gateway/playground/playground-stream';

const sse = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`;
const DONE = 'data: [DONE]\n\n';

async function* chunks(...values: Array<string | Uint8Array>) {
  for (const value of values) {
    yield value;
  }
}

function clockAt(times: number[]) {
  let index = 0;
  return () => times[Math.min(index++, times.length - 1)];
}

describe('readPlaygroundStream', () => {
  it('aggregates deltas and timings across chunk and UTF-8 boundaries', async () => {
    const encoder = new TextEncoder();
    const full = [
      sse({ model: 'gemini-3-flash', choices: [{ delta: { reasoning_content: 'Think ' } }] }),
      sse({ choices: [{ delta: { content: 'Привет' } }] }),
      sse({ choices: [{ delta: { content: ', world' } }] }),
      sse({ choices: [], usage: { prompt_tokens: 4, completion_tokens: 9, total_tokens: 13 } }),
      DONE,
    ].join('');
    // Split inside a multibyte character to prove the decoder is stateful.
    const mark = full.indexOf('Привет') + 4;
    const head = encoder.encode(full.slice(0, mark));
    const bytes = encoder.encode(full);
    const result = await readPlaygroundStream(chunks(head, bytes.slice(head.byteLength)), {
      startedAt: 0,
      now: clockAt([30, 40, 45, 60, 70]),
    });

    expect(result.model).toBe('gemini-3-flash');
    expect(result.content).toBe('Привет, world');
    expect(result.thinkingContent).toBe('Think ');
    expect(result.usage).toEqual({ prompt_tokens: 4, completion_tokens: 9, total_tokens: 13 });
    expect(result.timings).toEqual({
      durationMs: 70,
      firstReasoningDeltaMs: 30,
      firstTextDeltaMs: 40,
      lastDeltaMs: 45,
    });
  });

  it('accepts multiple events in one chunk and ignores comments', async () => {
    const result = await readPlaygroundStream(
      chunks(
        `: keep-alive\n\n${sse({ choices: [{ delta: { content: 'a' } }] })}${sse({
          choices: [{ delta: { content: 'b' } }],
        })}${DONE}`,
      ),
      { startedAt: 0, now: clockAt([10, 10, 20]) },
    );

    expect(result.content).toBe('ab');
    expect(result.timings.durationMs).toBe(20);
  });

  it('rejects malformed events instead of returning truncated success', async () => {
    await expect(
      readPlaygroundStream(chunks('data: {oops}\n\n'), { startedAt: 0, now: () => 0 }),
    ).rejects.toThrow(PlaygroundStreamError);
    await expect(
      readPlaygroundStream(chunks('data: {"choices":[{"delta":{"content":12}}]}\n\n'), {
        startedAt: 0,
        now: () => 0,
      }),
    ).rejects.toThrow('Malformed completion stream event');
  });

  it('rejects a stream that ends before the terminal marker', async () => {
    await expect(
      readPlaygroundStream(chunks(sse({ choices: [{ delta: { content: 'partial' } }] })), {
        startedAt: 0,
        now: () => 0,
      }),
    ).rejects.toThrow('ended before the API Proxy finished');
  });

  it('rejects a stream above the retained response limit', async () => {
    const oversized = `data: ${'x'.repeat(PLAYGROUND_STREAM_MAX_BYTES + 1)}\n\n`;
    await expect(
      readPlaygroundStream(chunks(oversized), { startedAt: 0, now: () => 0 }),
    ).rejects.toThrow('exceeded the playground response limit');
  });

  it('rejects unsupported chunk types', async () => {
    await expect(
      readPlaygroundStream(chunks(42 as never), { startedAt: 0, now: () => 0 }),
    ).rejects.toThrow('Unsupported completion stream chunk');
  });

  it('surfaces an error event from the gateway', async () => {
    await expect(
      readPlaygroundStream(chunks(sse({ error: { message: 'provider failed' } })), {
        startedAt: 0,
        now: () => 0,
      }),
    ).rejects.toThrow('provider failed');
  });
});
