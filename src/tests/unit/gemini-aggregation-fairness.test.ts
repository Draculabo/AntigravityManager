import { Readable } from 'node:stream';
import { setImmediate as tick } from 'node:timers/promises';
import { afterEach, expect, it, vi } from 'vitest';
import { collectGeminiStream } from '@/server/gateway/common/collect-gemini-stream';
import { aggregationByteAccounting } from '@/server/gateway/common/aggregation-byte-accounting';
import type { GeminiPart } from '@/modules/proxy-gateway/antigravity/types';

afterEach(() => {
  vi.restoreAllMocks();
  expect(aggregationByteAccounting.snapshot.totalBytes).toBe(0);
});

function frame(index: number): string {
  return `data: ${JSON.stringify({ response: { candidates: [{ content: { parts: [{ text: `answer ${index} 😀`, thoughtSignature: `signature-${index}` }] }, finishReason: 'STOP' }], usageMetadata: { totalTokenCount: index } } })}\n\n`;
}

function start(upstream: Readable, signal?: AbortSignal) {
  let seen = 0;
  let notifyFirstPart!: () => void;
  const firstPartSeen = new Promise<void>((resolve) => {
    notifyFirstPart = resolve;
  });
  let timeout = () => {};
  const clear = vi.fn();
  const operation = collectGeminiStream(upstream, {
    signal,
    createIdleTimer: (callback) => {
      timeout = callback;
      return { reset: () => {}, clear };
    },
    isPart: (value): value is GeminiPart => {
      if (value !== null && typeof value === 'object') {
        seen++;
        if (seen === 1) {
          notifyFirstPart();
        }
        return true;
      }
      return false;
    },
  });
  return { operation, clear, firstPartSeen, seen: () => seen, timeout: () => timeout() };
}

it('preserves CRLF and multibyte content across internal decode windows', async () => {
  const part = {
    text: 'x'.repeat(65500) + '😀漢字'.repeat(40000),
    thoughtSignature: 's'.repeat(1000),
  };
  const bytes = Buffer.from(
    `data: ${JSON.stringify({ response: { candidates: [{ content: { parts: [part] }, finishReason: 'STOP' }], usageMetadata: { totalTokenCount: 3 } } })}\r\n\r\n`,
  );
  const collection = start(Readable.from([bytes]));
  expect(await collection.operation).toEqual({
    candidates: [{ content: { role: 'model', parts: [part] }, finishReason: 'STOP' }],
    usageMetadata: { totalTokenCount: 3 },
  });
});

it('rejects overlapping delivery rather than overwriting the paused input or adding an unbounded queue', async () => {
  const upstream = new Readable({ read() {} });
  const collection = start(upstream);
  const rejected = expect(collection.operation).rejects.toThrow(
    'Upstream stream emitted data while aggregation was paused',
  );
  // Inject a transport that bypasses Readable.push and therefore ignores pause().
  upstream.emit('data', Buffer.from(Array.from({ length: 2000 }, (_, i) => frame(i)).join('')));
  expect(upstream.isPaused()).toBe(true);
  upstream.emit('data', Buffer.from(frame(2001)));
  await rejected;
  const stoppedAt = collection.seen();
  await tick();
  expect(collection.seen()).toBe(stoppedAt);
  expect(upstream.destroyed).toBe(true);
});

it.each(['one chunk', 'many chunks'] as const)(
  'allows another callback before completing a large burst in %s',
  async (kind) => {
    const frames = Array.from({ length: 2000 }, (_, i) => Buffer.from(frame(i)));
    const upstream = Readable.from(kind === 'one chunk' ? [Buffer.concat(frames)] : frames);
    let observed = 0;
    const collection = start(upstream);
    const marker = collection.firstPartSeen
      .then(() => tick())
      .then(() => {
        observed = collection.seen();
      });
    const response = await collection.operation;
    await marker;
    expect(observed).toBeGreaterThan(0);
    expect(observed).toBeLessThan(frames.length);
    expect(response).toEqual({
      candidates: [
        {
          content: {
            role: 'model',
            parts: Array.from({ length: frames.length }, (_, i) => ({
              text: `answer ${i} 😀`,
              thoughtSignature: `signature-${i}`,
            })),
          },
          finishReason: 'STOP',
        },
      ],
      usageMetadata: { totalTokenCount: frames.length - 1 },
    });
  },
);

it('cancels a large input before its remaining events are decoded', async () => {
  const abort = new AbortController();
  const upstream = Readable.from([
    Buffer.from(Array.from({ length: 2000 }, (_, i) => frame(i)).join('')),
  ]);
  const collection = start(upstream, abort.signal);
  const marker = collection.firstPartSeen.then(() => tick()).then(() => abort.abort());
  await expect(collection.operation).rejects.toMatchObject({ name: 'AbortError' });
  await marker;
  const stoppedAt = collection.seen();
  expect(stoppedAt).toBeGreaterThan(0);
  expect(stoppedAt).toBeLessThan(2000);
  await tick();
  expect(collection.seen()).toBe(stoppedAt);
  expect(upstream.destroyed).toBe(true);
  expect(['data', 'end', 'error', 'close'].map((name) => upstream.listenerCount(name))).toEqual([
    0, 0, 0, 0,
  ]);
  expect(collection.clear).toHaveBeenCalledOnce();
});

it('finishes every pending event when end and normal close arrive during a pause', async () => {
  const bytes = Buffer.from(Array.from({ length: 2000 }, (_, i) => frame(i)).join(''));
  const upstream = new Readable({ read() {} });
  const collection = start(upstream);
  upstream.emit('data', bytes);
  upstream.emit('end');
  upstream.emit('close');
  const response = await collection.operation;
  expect(response.candidates?.[0]?.content?.parts).toEqual(
    Array.from({ length: 2000 }, (_, i) => ({
      text: `answer ${i} 😀`,
      thoughtSignature: `signature-${i}`,
    })),
  );
  expect(response.usageMetadata).toEqual({ totalTokenCount: 1999 });
  expect(collection.clear).toHaveBeenCalledOnce();
  upstream.destroy();
});

it.each(['error', 'close', 'idle'] as const)(
  'releases a paused input after %s without later resuming work',
  async (kind) => {
    const upstream = new Readable({ read() {} });
    const marker = tick().then(() => {
      if (kind === 'idle') {
        collection.timeout();
      } else {
        upstream.emit(kind, new Error('fixture failure'));
      }
    });
    const collection = start(upstream);
    const rejected = expect(collection.operation).rejects.toThrow();
    upstream.emit('data', Buffer.from(Array.from({ length: 2000 }, (_, i) => frame(i)).join('')));
    await rejected;
    await marker;
    const stoppedAt = collection.seen();
    expect(stoppedAt).toBeLessThan(2000);
    await tick();
    expect(collection.seen()).toBe(stoppedAt);
    expect(upstream.destroyed).toBe(true);
    expect(collection.clear).toHaveBeenCalledOnce();
  },
);
