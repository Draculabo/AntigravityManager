vi.mock('@/server/gateway/common/utils/request-user-agent', () => ({
  resolveRequestUserAgent: async () => 'aggregation-fixture',
  resolveLocalInstalledVersion: () => '0.0.0',
}));
import { Readable } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';
import { AntigravityGenerationExecutor } from '@/server/gateway/common/antigravity-generation-executor';
import {
  AggregationAdmission,
  AggregationAdmissionError,
  aggregationAdmission,
} from '@/server/gateway/common/aggregation-admission';
import { aggregateGeminiFallback } from '@/server/gateway/common/aggregate-gemini-fallback';
import {
  createAccount,
  createGateway,
  createLease,
  createUpstream,
} from './proxy-real-path.harness';

const frame = Buffer.from(
  'data: {"response":{"candidates":[{"content":{"parts":[{"text":"done"}]},"finishReason":"STOP"}]}}\n\n',
);
function generateWithStream(
  client: ConstructorParameters<typeof AntigravityGenerationExecutor>[0],
  signal?: AbortSignal,
) {
  const executor = new AntigravityGenerationExecutor(client, {
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  });
  return executor.generate({
    body: {
      model: 'fixture',
      project: '',
      requestId: 'fixture',
      userAgent: 'fixture',
      request: { contents: [] },
    },
    accessToken: 'fixture',
    signal,
    options: { recoveryBudget: { attempted: false, thinkingOnlyEnabled: false } },
  });
}
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it('normalizes provider cancellation before the fallback starts', async () => {
  const abort = new AbortController();
  let fail: ((error: Error) => void) | undefined;
  const start = vi.fn();
  const operation = generateWithStream(
    {
      generateInternal: () =>
        new Promise((_resolve, reject) => {
          fail = reject;
        }),
      streamGenerateInternal: start,
    },
    abort.signal,
  );
  const rejected = expect(operation).rejects.toMatchObject({ name: 'AbortError' });
  await vi.waitFor(() => expect(fail).toBeTypeOf('function'));
  abort.abort();
  const error = new Error('fixture provider cancellation');
  error.name = 'CanceledError';
  fail!(error);
  await rejected;
  expect(start).not.toHaveBeenCalled();
  expect(aggregationAdmission.snapshot).toEqual({ active: 0, waiting: 0 });
});

it('admits only two shared fallback streams and cancels waiting work before upstream creation', async () => {
  const streams: Readable[] = [];
  let cleaning = false;
  const start = vi.fn(async () => {
    const stream = cleaning ? Readable.from([frame]) : new Readable({ read() {} });
    streams.push(stream);
    return stream;
  });
  const client = {
    generateInternal: async () => ({ candidates: [] }),
    streamGenerateInternal: start,
  };
  const signals = Array.from({ length: 4 }, () => new AbortController());
  const operations = signals.map((signal) => generateWithStream(client, signal.signal));
  const outcomes = operations.map((operation) =>
    operation.then(
      () => 'completed',
      (error) => (error instanceof Error ? error.name : 'unknown'),
    ),
  );
  try {
    await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(2));
    signals[2]!.abort();
    expect(await outcomes[2]).toBe('AbortError');
    expect(start).toHaveBeenCalledTimes(2);
  } finally {
    cleaning = true;
    for (const stream of streams) {
      stream.push(frame);
      stream.push(null);
    }
    await Promise.all(outcomes);
  }
  expect(start).toHaveBeenCalledTimes(3);
});

it('keeps FIFO order, bounds the queue and releases cancellation listeners', async () => {
  const gate = new AggregationAdmission(1, 2, 30_000);
  const first = await gate.acquire();
  const signal = new AbortController();
  const removed = vi.spyOn(signal.signal, 'removeEventListener');
  const cancelled = gate.acquire(signal.signal);
  const rejected = expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });
  const order: number[] = [];
  const second = gate.acquire().then((release) => {
    order.push(2);
    return release;
  });
  await expect(gate.acquire()).rejects.toBeInstanceOf(AggregationAdmissionError);
  signal.abort();
  await rejected;
  expect(removed).toHaveBeenCalledWith('abort', expect.any(Function));
  const third = gate.acquire().then((release) => {
    order.push(3);
    return release;
  });
  first();
  const releaseSecond = await second;
  expect(order).toEqual([2]);
  releaseSecond();
  const releaseThird = await third;
  releaseThird();
  releaseThird();
  expect(order).toEqual([2, 3]);
  expect(gate.snapshot).toEqual({ active: 0, waiting: 0 });
});

it('removes timed out and already aborted waiters without granting credits', async () => {
  vi.useFakeTimers();
  const gate = new AggregationAdmission(1, 1, 10);
  const release = await gate.acquire();
  const waiting = gate.acquire();
  const rejected = expect(waiting).rejects.toMatchObject({ status: 503 });
  await vi.advanceTimersByTimeAsync(10);
  await rejected;
  const aborted = new AbortController();
  aborted.abort();
  await expect(gate.acquire(aborted.signal)).rejects.toMatchObject({ name: 'AbortError' });
  expect(gate.snapshot).toEqual({ active: 1, waiting: 0 });
  release();
  expect(vi.getTimerCount()).toBe(0);
});

it('holds a cancelled unresolved start credit until the late stream is destroyed', async () => {
  const abort = new AbortController();
  let resolveLate: ((stream: Readable) => void) | undefined;
  const operation = aggregateGeminiFallback(
    () =>
      new Promise((resolve) => {
        resolveLate = resolve;
      }),
    async () => {
      throw Error('Cancelled stream must not be collected');
    },
    abort.signal,
  );
  const rejected = expect(operation).rejects.toMatchObject({ name: 'AbortError' });
  await vi.waitFor(() => expect(resolveLate).toBeTypeOf('function'));
  abort.abort();
  await rejected;
  expect(aggregationAdmission.snapshot).toEqual({ active: 1, waiting: 0 });
  const late = new Readable({ read() {} });
  resolveLate!(late);
  await vi.waitFor(() => expect(aggregationAdmission.snapshot).toEqual({ active: 0, waiting: 0 }));
  expect(late.destroyed).toBe(true);
});

it('cancels an active collector even when the provider ignores its signal', async () => {
  const stream = new Readable({ read() {} });
  const abort = new AbortController();
  const operation = generateWithStream(
    {
      generateInternal: async () => ({ candidates: [] }),
      streamGenerateInternal: async () => stream,
    },
    abort.signal,
  );
  const rejected = expect(operation).rejects.toMatchObject({ name: 'AbortError' });
  try {
    await vi.waitFor(() => expect(stream.listenerCount('data')).toBe(1));
    abort.abort();
    await rejected;
    expect(stream.destroyed).toBe(true);
    expect(stream.listenerCount('data')).toBe(0);
    expect(aggregationAdmission.snapshot).toEqual({ active: 0, waiting: 0 });
  } finally {
    abort.abort();
    stream.destroy();
  }
});

it.each(['openai', 'gemini', 'anthropic'] as const)(
  'does not rotate or penalize accounts on local queue overflow: %s',
  async (kind) => {
    const releases = await Promise.all([
      aggregationAdmission.acquire(),
      aggregationAdmission.acquire(),
    ]);
    const aborts = Array.from({ length: 8 }, () => new AbortController());
    const waiters = aborts.map((abort) =>
      aggregationAdmission.acquire(abort.signal).catch(() => undefined),
    );
    const upstream = createUpstream({ generate: { candidates: [] } });
    const lease = createLease([createAccount('acc-1')]);
    const services = createGateway(upstream, lease);
    try {
      const operation =
        kind === 'openai'
          ? services.openAIService.handleChatCompletions({
              model: 'gemini-3-flash',
              messages: [{ role: 'user', content: 'fixture' }],
              stream: false,
            })
          : kind === 'gemini'
            ? services.geminiService.handleGeminiGenerateContent('gemini-3-flash', {
                contents: [{ role: 'user', parts: [{ text: 'fixture' }] }],
              })
            : services.anthropicService.handleAnthropicMessages({
                model: 'gemini-3-flash',
                messages: [{ role: 'user', content: 'fixture' }],
                stream: false,
                max_tokens: 16,
              });
      await expect(operation).rejects.toMatchObject({ status: 503 });
      expect(upstream.calls.map((call) => call.kind)).toEqual(['generate']);
      expect(lease.penalties).toEqual([]);
    } finally {
      aborts.forEach((abort) => abort.abort());
      await Promise.all(waiters);
      releases.forEach((release) => release());
    }
    expect(aggregationAdmission.snapshot).toEqual({ active: 0, waiting: 0 });
  },
);

it.each(['openai', 'gemini', 'anthropic'] as const)(
  'does not rotate or penalize accounts when waiting is cancelled: %s',
  async (kind) => {
    const releases = await Promise.all([
      aggregationAdmission.acquire(),
      aggregationAdmission.acquire(),
    ]);
    const abort = new AbortController();
    const upstream = createUpstream({ generate: { candidates: [] } });
    const lease = createLease([createAccount('acc-1')]);
    const services = createGateway(upstream, lease);
    try {
      const operation =
        kind === 'openai'
          ? services.openAIService.handleChatCompletions(
              {
                model: 'gemini-3-flash',
                messages: [{ role: 'user', content: 'fixture' }],
                stream: false,
              },
              'chat-completions',
              abort.signal,
            )
          : kind === 'gemini'
            ? services.geminiService.handleGeminiGenerateContent(
                'gemini-3-flash',
                { contents: [{ role: 'user', parts: [{ text: 'fixture' }] }] },
                'generate-content',
                abort.signal,
              )
            : services.anthropicService.handleAnthropicMessages(
                {
                  model: 'gemini-3-flash',
                  messages: [{ role: 'user', content: 'fixture' }],
                  stream: false,
                  max_tokens: 16,
                },
                undefined,
                abort.signal,
              );
      const rejected = expect(operation).rejects.toMatchObject({ name: 'AbortError' });
      await vi.waitFor(() => expect(aggregationAdmission.snapshot.waiting).toBe(1));
      abort.abort();
      await rejected;
      expect(upstream.calls.map((call) => call.kind)).toEqual(['generate']);
      expect(lease.penalties).toEqual([]);
    } finally {
      abort.abort();
      releases.forEach((release) => release());
    }
    expect(aggregationAdmission.snapshot).toEqual({ active: 0, waiting: 0 });
  },
);
