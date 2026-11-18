import { describe, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';

import { IncrementalSseRedactor } from '@/modules/proxy-gateway/audit/incremental-sse-redactor';
import { GeminiClient } from '@/server/gateway/modules/gemini/gemini-client.service';
import { Upstream4xxCaptureService } from '@/server/gateway/common/upstream-4xx-capture.service';

const axiosMock = vi.hoisted(() => ({
  post: vi.fn(),
  create: vi.fn(() => ({ get: vi.fn(), post: vi.fn() })),
  isAxiosError: vi.fn(() => false),
}));

vi.mock('axios', () => ({ default: axiosMock, ...axiosMock }));

// Exercise the existing parser cap with small events instead of allocating production-size bodies.
vi.mock('@/modules/proxy-gateway/audit/audit-sanitizer', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/modules/proxy-gateway/audit/audit-sanitizer')>()),
  MAX_AUDIT_BODY_BYTES: 256,
}));

describe('original SSE frame observation', () => {
  it('emits original UTF-8 framing only after an event boundary, separately from sanitized data', () => {
    const frames: Array<readonly string[] | null> = [];
    const original: unknown[] = [];
    const sanitized: unknown[] = [];
    const redactor = new IncrementalSseRedactor({
      onRawParsedEvent: (event) => original.push(event),
      onRawFrame: (frame) => frames.push(frame),
      onParsedEvent: (event) => sanitized.push(event),
    });
    const wire =
      'event: message\r\nid: 7\r\ndata: {"authorization":"Bearer synthetic","text":"中文"}\r\n\r\n';
    const bytes = Buffer.from(wire);
    const split = bytes.indexOf(Buffer.from('中文')) + 1;
    expect(redactor.push(bytes.subarray(0, split))).toEqual([]);
    expect(frames).toEqual([]);
    redactor.push(bytes.subarray(split, bytes.length - 1));
    expect(frames).toEqual([]);
    redactor.push(bytes.subarray(bytes.length - 1));
    redactor.finish();
    expect(frames.map((frame) => frame?.join(''))).toEqual([wire]);
    expect(original).toEqual([{ authorization: 'Bearer synthetic', text: '中文' }]);
    expect(sanitized).toEqual([{ authorization: '[REDACTED]', text: '中文' }]);
  });

  it('preserves comments, multiline data, blank frames and a final event without a delimiter', () => {
    const frames: Array<readonly string[] | null> = [];
    const redactor = new IncrementalSseRedactor({ onRawFrame: (frame) => frames.push(frame) });
    const wire = '\n: comment\n\ndata: {"text":\ndata: "ok"}\n\ndata: [DONE]';
    for (const character of wire) {
      redactor.push(character);
    }
    redactor.finish();
    expect(frames.map((frame) => frame?.join(''))).toEqual([
      '\n',
      ': comment\n\n',
      'data: {"text":\ndata: "ok"}\n\n',
      'data: [DONE]',
    ]);
    expect(frames.flat().join('')).toBe(wire);
  });

  it('signals a cap violation once and never supplies a partial original frame', () => {
    const frames: Array<readonly string[] | null> = [];
    const parsed: unknown[] = [];
    const redactor = new IncrementalSseRedactor({
      onRawParsedEvent: (event) => parsed.push(event),
      onRawFrame: (frame) => frames.push(frame),
    });
    redactor.push('data: {"text":"' + 'x'.repeat(300));
    expect(frames).toEqual([null]);
    redactor.push('more"}\n\n');
    const final = redactor.finish();
    expect(frames).toEqual([null]);
    expect(parsed).toEqual([]);
    expect(final.result.errorSummary).toBe('SSE event exceeds the incremental JSON event limit');
  });

  it('fails and closes the real generation transport when an event exceeds the parser cap', async () => {
    const source = Readable.from(['data: {"text":"' + 'x'.repeat(300), 'more"}\n\n']);
    axiosMock.post.mockResolvedValueOnce({ status: 200, headers: {}, data: source });
    const client = new GeminiClient(new Upstream4xxCaptureService());
    const stream = await client.streamGenerate(
      'gemini-3-flash',
      { contents: [] },
      'synthetic-token',
    );
    const consume = async () => {
      for await (const chunk of stream) {
        void chunk;
      }
    };
    await expect(consume()).rejects.toMatchObject({
      message: 'Upstream SSE event exceeds signature validation budget.',
    });
    expect(source.destroyed).toBe(true);
    expect(axiosMock.post).toHaveBeenCalledTimes(1);
  });
});
