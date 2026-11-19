import { PassThrough, Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AntigravityGenerationExecutor } from '@/server/gateway/common/antigravity-generation-executor';
import { type GeminiResponse } from '@/server/gateway/common/interfaces/request-interfaces';

function generateWithStream(stream: Readable): Promise<GeminiResponse> {
  const executor = new AntigravityGenerationExecutor(
    {
      generateInternal: async () => ({ candidates: [] }),
      streamGenerateInternal: async () => stream,
    },
    { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
  );
  return executor.generate({
    body: {
      model: 'fixture',
      project: '',
      requestId: 'fixture',
      userAgent: 'fixture',
      request: { contents: [] },
    },
    accessToken: 'fixture',
    options: { recoveryBudget: { attempted: false, thinkingOnlyEnabled: false } },
  });
}

function frame(text: string): Buffer {
  return Buffer.from(
    `data: ${JSON.stringify({
      response: {
        candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP' }],
        usageMetadata: { totalTokenCount: 2 },
      },
    })}\n\n`,
  );
}

describe('unary Gemini stream aggregation ownership', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('detaches collector listeners from a retained completed upstream', async () => {
    const upstream = Readable.from([frame('answer 😀')]);
    const response = await generateWithStream(upstream);
    expect(response).toEqual({
      candidates: [
        { content: { role: 'model', parts: [{ text: 'answer 😀' }] }, finishReason: 'STOP' },
      ],
      usageMetadata: { totalTokenCount: 2 },
    });
    expect(['data', 'end', 'error'].map((name) => upstream.listenerCount(name))).toEqual([0, 0, 0]);
  });

  it('scans fragmented long lines with linear work', async () => {
    const text = 'x'.repeat(64 * 1024) + '😀';
    const bytes = frame(text);
    const fragments: Buffer[] = [];
    for (let offset = 0; offset < bytes.length; offset += 1024) {
      fragments.push(bytes.subarray(offset, offset + 1024));
    }
    const upstream = Readable.from(fragments);
    const split = String.prototype.split;
    let scanned = 0;
    vi.spyOn(String.prototype, 'split').mockImplementation(function (
      this: string,
      separator: string | RegExp | { [Symbol.split](text: string, limit?: number): string[] },
      limit?: number,
    ) {
      if (separator === '\n' && this.startsWith('data: ')) {
        scanned += this.length;
      }
      return Reflect.apply(split, this, [separator, limit]);
    });
    const response = await generateWithStream(upstream);
    expect(response.candidates?.[0]?.content?.parts).toEqual([{ text }]);
    expect(scanned).toBeLessThanOrEqual(bytes.length * 2);
  });

  it('rejects malformed input without removing caller listeners', async () => {
    const upstream = new PassThrough();
    const caller = vi.fn();
    upstream.on('data', caller);
    const operation = generateWithStream(upstream);
    const rejected = expect(operation).rejects.toMatchObject({
      code: 'invalid_upstream_response',
      status: 502,
    });
    try {
      await vi.waitFor(() => expect(upstream.listenerCount('data')).toBe(2));
      upstream.end('data: invalid\r\n\n');
      await rejected;
      expect(upstream.listeners('data')).toEqual([caller]);
    } finally {
      upstream.destroy();
    }
  });

  it('rejects empty input and releases listeners', async () => {
    const upstream = Readable.from([]);
    await expect(generateWithStream(upstream)).rejects.toThrow('Empty response stream');
    expect(['data', 'end', 'error', 'close'].map((name) => upstream.listenerCount(name))).toEqual([
      0, 0, 0, 0,
    ]);
  });

  it.each(['error', 'close', 'already destroyed'])('releases collection after %s', async (kind) => {
    const upstream = new Readable({ read() {} });
    if (kind === 'already destroyed') {
      upstream.destroy();
    }
    const operation = generateWithStream(upstream);
    const rejected = expect(operation).rejects.toThrow(
      kind === 'error' ? 'fixture failure' : 'Upstream stream closed before completion',
    );
    try {
      if (kind !== 'already destroyed') {
        await vi.waitFor(() => expect(upstream.listenerCount('data')).toBe(1));
        upstream.destroy(kind === 'error' ? new Error('fixture failure') : undefined);
      }
      await rejected;
      expect(['data', 'end', 'error', 'close'].map((name) => upstream.listenerCount(name))).toEqual(
        [0, 0, 0, 0],
      );
    } finally {
      upstream.destroy();
    }
  });

  it('releases partial collection and upstream on idle timeout', async () => {
    vi.useFakeTimers();
    const upstream = new Readable({ read() {} });
    const operation = generateWithStream(upstream);
    const rejected = expect(operation).rejects.toThrow('Stream idle timeout');
    await vi.advanceTimersByTimeAsync(300_000);
    await rejected;
    expect(upstream.destroyed).toBe(true);
    expect(['data', 'end', 'error', 'close'].map((name) => upstream.listenerCount(name))).toEqual([
      0, 0, 0, 0,
    ]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('retains every part in large candidate arrays', async () => {
    const parts = Array.from({ length: 140_000 }, (_, index) => ({ text: String(index) }));
    const upstream = Readable.from([
      Buffer.from(
        `data: ${JSON.stringify({ response: { candidates: [{ content: { parts }, finishReason: 'STOP' }] } })}\n\n`,
      ),
    ]);
    const response = await generateWithStream(upstream);
    expect(response.candidates?.[0]?.content?.parts).toEqual(parts);
  });
});
