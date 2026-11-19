import { Readable } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';
import { AntigravityGenerationExecutor } from '@/server/gateway/common/antigravity-generation-executor';
import {
  AggregationAdmission,
  aggregationAdmission,
} from '@/server/gateway/common/aggregation-admission';
import {
  AggregationByteAccounting,
  aggregationByteAccounting,
} from '@/server/gateway/common/aggregation-byte-accounting';
import { aggregateGeminiFallback } from '@/server/gateway/common/aggregate-gemini-fallback';
import { collectGeminiStream } from '@/server/gateway/common/collect-gemini-stream';
import {
  estimateParsedJsonBytes,
  estimateRetainedJsonBytes,
} from '@/server/gateway/common/retained-json-size';
import type { GeminiInternalRequest } from '@/modules/proxy-gateway/antigravity/types';

it('accounts the complete waiting request without another JSON serialization and removes it on cancellation', async () => {
  const releases = await Promise.all([
    aggregationAdmission.acquire(),
    aggregationAdmission.acquire(),
  ]);
  const abort = new AbortController();
  const text = 'x'.repeat(256 * 1024) + '😀';
  const body: GeminiInternalRequest = {
    model: 'fixture',
    project: '',
    requestId: 'fixture',
    userAgent: 'fixture',
    request: {
      contents: [
        {
          role: 'user',
          parts: [
            { text },
            { inlineData: { mimeType: 'image/png', data: 'YQ=='.repeat(32 * 1024) } },
          ],
        },
      ],
    },
  };
  const stringify = vi.spyOn(JSON, 'stringify');
  const executor = new AntigravityGenerationExecutor(
    {
      generateInternal: async () => ({ candidates: [] }),
      streamGenerateInternal: async () => Readable.from([]),
    },
    { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
  );
  const operation = executor.generate({ body, accessToken: 'fixture', signal: abort.signal });
  const rejected = expect(operation).rejects.toMatchObject({ name: 'AbortError' });
  try {
    await vi.waitFor(() => expect(aggregationAdmission.snapshot.waiting).toBe(1));
    expect(aggregationAdmission.byteSnapshot.waitingRequestBytes).toBe(
      estimateRetainedJsonBytes(body),
    );
    expect(aggregationAdmission.byteSnapshot.waitingRequestBytes).toBeGreaterThanOrEqual(
      2 * (text.length + 128 * 1024),
    );
    expect(stringify).not.toHaveBeenCalled();
  } finally {
    abort.abort();
    await rejected;
    releases.forEach((release) => release());
    stringify.mockRestore();
  }
  expect(aggregationAdmission.byteSnapshot).toMatchObject({
    waitingRequestBytes: 0,
    activeRequestBytes: 0,
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  expect(aggregationAdmission.snapshot).toEqual({ active: 0, waiting: 0 });
  expect(aggregationByteAccounting.snapshot.totalBytes).toBe(0);
});

it('walks deep JSON iteratively and accounts signatures, tool arguments and inline media', () => {
  let nested: object = { text: '😀' };
  for (let depth = 0; depth < 5000; depth++) {
    nested = { child: nested };
  }
  const part = {
    thoughtSignature: 's'.repeat(2048),
    functionCall: { name: 'fixture', args: { nested } },
    inlineData: { mimeType: 'image/png', data: 'YQ=='.repeat(1024) },
  };
  const stringify = vi.spyOn(JSON, 'stringify');
  const bytes = estimateRetainedJsonBytes(part);
  expect(bytes).toBeGreaterThan(2 * (2048 + 4096));
  expect(
    estimateRetainedJsonBytes({ ...part, thoughtSignature: part.thoughtSignature + '😀' }) - bytes,
  ).toBe(4);
  const shared = { nested };
  expect(estimateRetainedJsonBytes([shared, shared])).toBeLessThan(
    estimateRetainedJsonBytes([shared]) * 1.01,
  );
  expect(stringify).not.toHaveBeenCalled();
});

it('moves waiting bytes to the active owner without double charging and releases idempotently', async () => {
  const bytes = new AggregationByteAccounting();
  const gate = new AggregationAdmission(1, 1, 30_000, bytes);
  const release = await gate.acquire(undefined, 1024);
  const waiting = gate.acquire(undefined, 4096);
  expect(gate.byteSnapshot).toMatchObject({
    waitingRequestBytes: 4096,
    activeRequestBytes: 1024,
    totalBytes: 5120,
  });
  release();
  release();
  const releaseNext = await waiting;
  expect(gate.byteSnapshot).toMatchObject({
    waitingRequestBytes: 0,
    activeRequestBytes: 4096,
    totalBytes: 4096,
    peakBytes: 5120,
  });
  releaseNext();
  releaseNext();
  expect(gate.byteSnapshot.totalBytes).toBe(0);
});

it('preserves byte accounting for parsed scalar arrays, nested tools and deep trees', () => {
  const texts = [
    'null',
    '[true,false,0,1.5,"😀",null]',
    JSON.stringify({
      functionCall: {
        name: 'fixture',
        args: {
          rows: Array.from({ length: 1000 }, (_, index) => ({
            index,
            detail: { value: String(index), flags: [true, false] },
          })),
        },
      },
    }),
    JSON.stringify({
      thoughtSignature: 's'.repeat(1024),
      inlineData: { mimeType: 'image/png', data: 'YQ=='.repeat(1024) },
    }),
    '{"child":'.repeat(5000) + '{"text":"😀"}' + '}'.repeat(5000),
  ];
  for (const text of texts) {
    const parsed: unknown = JSON.parse(text);
    expect(estimateParsedJsonBytes(parsed)).toBe(estimateRetainedJsonBytes(parsed));
  }
});

it('keeps translated request aliases distinct from independently parsed copies', () => {
  const shared = { nested: { text: 'fixture'.repeat(1024), flags: [true, false] } };
  const request = { first: shared, second: shared };
  const parsed: unknown = JSON.parse(JSON.stringify(request));
  expect(estimateRetainedJsonBytes(request)).toBeLessThan(estimateParsedJsonBytes(parsed));
  expect(estimateRetainedJsonBytes(parsed)).toBe(estimateParsedJsonBytes(parsed));
});

it.each(['abort', 'timeout', 'full'] as const)(
  'removes waiting bytes on %s while preserving active ownership',
  async (kind) => {
    vi.useFakeTimers();
    const bytes = new AggregationByteAccounting();
    const gate = new AggregationAdmission(1, 1, 10, bytes);
    const release = await gate.acquire(undefined, 1024);
    const abort = new AbortController();
    const waiting = gate.acquire(abort.signal, 4096);
    const rejected = expect(waiting).rejects.toThrow();
    if (kind === 'full') {
      await expect(gate.acquire(undefined, 8192)).rejects.toThrow('queue is full');
      expect(gate.byteSnapshot.totalBytes).toBe(5120);
    }
    if (kind === 'timeout') {
      await vi.advanceTimersByTimeAsync(10);
    } else {
      abort.abort();
    }
    await rejected;
    expect(gate.byteSnapshot).toMatchObject({
      activeRequestBytes: 1024,
      waitingRequestBytes: 0,
      totalBytes: 1024,
    });
    release();
    expect(gate.byteSnapshot.totalBytes).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  },
);

it('keeps active request bytes until a cancelled pending provider actually settles', async () => {
  let returnStream: (stream: NodeJS.ReadableStream) => void = () => {};
  const pending = new Promise<NodeJS.ReadableStream>((resolve) => {
    returnStream = resolve;
  });
  const start = vi.fn(() => pending);
  const abort = new AbortController();
  const operation = aggregateGeminiFallback(
    start,
    async () => ({ candidates: [] }),
    abort.signal,
    8192,
  );
  const rejected = expect(operation).rejects.toMatchObject({ name: 'AbortError' });
  await vi.waitFor(() => expect(start).toHaveBeenCalledOnce());
  abort.abort();
  await rejected;
  expect(aggregationAdmission.byteSnapshot.activeRequestBytes).toBe(8192);
  const late = new Readable({ read() {} });
  returnStream(late);
  await vi.waitFor(() => expect(aggregationAdmission.byteSnapshot.totalBytes).toBe(0));
  expect(late.destroyed).toBe(true);
});

function frame(response: object): Buffer {
  return Buffer.from(`data: ${JSON.stringify({ response })}\n\n`);
}

function collect(upstream: Readable, signal?: AbortSignal) {
  let idle = () => {};
  const clear = vi.fn();
  const operation = collectGeminiStream(upstream, {
    signal,
    createIdleTimer: (callback) => {
      idle = callback;
      return { reset: () => {}, clear };
    },
    isPart: (
      value,
    ): value is NonNullable<
      GeminiInternalRequest['request']['contents']
    >[number]['parts'][number] => value !== null && typeof value === 'object',
  });
  return { operation, clear, timeout: () => idle() };
}

it('accounts unfinished lines, parts and replacement metadata then hands the complete result to its caller', async () => {
  const part = {
    text: 'answer 😀',
    thoughtSignature: 's'.repeat(2048),
    functionCall: { name: 'fixture', args: { list: ['a'.repeat(1024)] } },
    inlineData: { mimeType: 'image/png', data: 'YQ=='.repeat(512) },
  };
  const largeUsage = { totalTokenCount: 5, fixtureDetail: 'm'.repeat(2048) };
  const smallUsage = { totalTokenCount: 6 };
  const first = frame({ candidates: [{ content: { parts: [part] } }], usageMetadata: largeUsage });
  const second = frame({ candidates: [{ finishReason: 'STOP' }], usageMetadata: smallUsage });
  const upstream = new Readable({ read() {} });
  const collection = collect(upstream);
  const stringify = vi.spyOn(JSON, 'stringify');
  try {
    upstream.emit('data', first.subarray(0, 1024));
    expect(aggregationByteAccounting.snapshot).toMatchObject({
      unfinishedLineBytes: new TextDecoder().decode(first.subarray(0, 1024)).length * 2 + 64,
      transientBytes: 0,
      metadataBytes: 0,
    });
    upstream.emit('data', first.subarray(1024));
    const firstSnapshot = aggregationByteAccounting.snapshot;
    expect(firstSnapshot.unfinishedLineBytes).toBe(0);
    expect(firstSnapshot.partBytes).toBe(64 + estimateRetainedJsonBytes(part));
    expect(firstSnapshot.metadataBytes).toBe(estimateRetainedJsonBytes(largeUsage));
    upstream.emit('data', second);
    const secondSnapshot = aggregationByteAccounting.snapshot;
    expect(secondSnapshot.partBytes).toBe(firstSnapshot.partBytes);
    expect(secondSnapshot.metadataBytes).toBe(
      estimateRetainedJsonBytes(smallUsage) + estimateRetainedJsonBytes('STOP'),
    );
    expect(secondSnapshot.metadataBytes).toBeLessThan(firstSnapshot.metadataBytes);
    expect(secondSnapshot.peakBytes).toBeGreaterThan(firstSnapshot.totalBytes);
    upstream.emit('end');
    expect(await collection.operation).toEqual({
      candidates: [{ content: { role: 'model', parts: [part] }, finishReason: 'STOP' }],
      usageMetadata: smallUsage,
    });
    expect(collection.clear).toHaveBeenCalledOnce();
    expect(stringify).not.toHaveBeenCalled();
  } finally {
    stringify.mockRestore();
    upstream.destroy();
    await collection.operation.catch(() => {});
  }
});

it.each(['abort', 'error', 'close', 'idle'] as const)(
  'clears retained collection bytes on %s',
  async (kind) => {
    const upstream = new Readable({ read() {} });
    const abort = new AbortController();
    const collection = collect(upstream, abort.signal);
    const rejected = expect(collection.operation).rejects.toThrow();
    upstream.emit(
      'data',
      frame({
        candidates: [{ content: { parts: [{ text: 'retained'.repeat(1024) }] } }],
        usageMetadata: { totalTokenCount: 1 },
      }),
    );
    upstream.emit('data', Buffer.from('data: {"unfinished":"' + 'x'.repeat(2048)));
    expect(aggregationByteAccounting.snapshot.partBytes).toBeGreaterThan(1024);
    expect(aggregationByteAccounting.snapshot.unfinishedLineBytes).toBeGreaterThan(2048);
    if (kind === 'abort') {
      abort.abort();
    } else if (kind === 'idle') {
      collection.timeout();
    } else {
      upstream.emit(kind, new Error('fixture failure'));
    }
    await rejected;
    expect(aggregationByteAccounting.snapshot.totalBytes).toBe(0);
    expect(['data', 'end', 'error', 'close'].map((name) => upstream.listenerCount(name))).toEqual([
      0, 0, 0, 0,
    ]);
    expect(collection.clear).toHaveBeenCalledOnce();
  },
);
