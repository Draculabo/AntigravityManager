import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BaseProxyService } from '@/server/gateway/common/base-proxy.service';
import { type GeminiResponse } from '@/server/gateway/common/interfaces/request-interfaces';

class AggregationService extends BaseProxyService {
  constructor(stream: Readable) {
    super(
      {} as never,
      {
        generateInternal: async () => ({ candidates: [] }),
        streamGenerateInternal: async () => stream,
      } as never,
      {} as never,
      {} as never,
      {} as never,
    );
  }

  run(): Promise<GeminiResponse> {
    return this.generateInternalWithStreamFallback(
      {
        model: 'fixture',
        project: '',
        requestId: 'fixture',
        userAgent: 'fixture',
        request: { contents: [] },
      },
      'fixture',
    );
  }
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
    const response = await new AggregationService(upstream).run();
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
    const response = await new AggregationService(upstream).run();
    expect(response.candidates?.[0]?.content?.parts).toEqual([{ text }]);
    expect(scanned).toBeLessThanOrEqual(bytes.length * 2);
  });

  it('rejects malformed input without removing caller listeners', async () => {
    const upstream = Readable.from([
      Buffer.from(
        'data: invalid\r\n\ndata: [DONE]\n\ndata: {"response":{"candidates":[{"content":{"parts":[null,7]}}]}}\n\n',
      ),
      frame('kept'),
      Buffer.from('data: {"response":{"candidates":[]}}'),
    ]);
    const caller = vi.fn();
    upstream.on('data', caller);
    await expect(new AggregationService(upstream).run()).rejects.toMatchObject({
      code: 'invalid_upstream_response',
      status: 502,
    });
    expect(upstream.listeners('data')).toEqual([caller]);
  });

  it('rejects empty input and releases listeners', async () => {
    const upstream = Readable.from([]);
    await expect(new AggregationService(upstream).run()).rejects.toThrow('Empty response stream');
    expect(['data', 'end', 'error', 'close'].map((name) => upstream.listenerCount(name))).toEqual([
      0, 0, 0, 0,
    ]);
  });

  it.each(['error', 'close', 'already destroyed'])('releases collection after %s', async (kind) => {
    const upstream = new Readable({ read() {} });
    if (kind === 'already destroyed') {
      upstream.destroy();
    }
    const operation = new AggregationService(upstream).run();
    const rejected = expect(operation).rejects.toThrow(
      kind === 'error' ? 'fixture failure' : 'Upstream stream closed before completion',
    );
    await vi.waitFor(() => {
      if (kind !== 'already destroyed') {
        expect(upstream.listenerCount('data')).toBe(1);
      }
    });
    if (kind !== 'already destroyed') {
      upstream.destroy(kind === 'error' ? new Error('fixture failure') : undefined);
    }
    await rejected;
    expect(['data', 'end', 'error', 'close'].map((name) => upstream.listenerCount(name))).toEqual([
      0, 0, 0, 0,
    ]);
  });

  it('releases partial collection and upstream on idle timeout', async () => {
    vi.useFakeTimers();
    const upstream = new Readable({ read() {} });
    const operation = new AggregationService(upstream).run();
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
    const response = await new AggregationService(upstream).run();
    expect(response.candidates?.[0]?.content?.parts).toEqual(parts);
  });
});
