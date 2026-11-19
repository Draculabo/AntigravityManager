import { performance } from 'node:perf_hooks';
import { addAbortSignal, PassThrough } from 'node:stream';

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Observable } from 'rxjs';

import type { AnthropicService } from '@/server/gateway/modules/anthropic/anthropic.service';
import { startGenerationStreamAttempt } from '@/server/gateway/common/generation-deadline';
import { captureGeminiStreamResult } from '@/server/gateway/modules/gemini/gemini-stream-capture';
import { DEFAULT_APP_CONFIG } from '@/modules/config/types';
import { getServerConfig, setServerConfig } from '@/server/server-config';
import {
  createAccount,
  createGateway,
  createLease,
  createUpstream,
  geminiStreamFrame,
} from './proxy-real-path.harness';

const ping = 'event: ping\ndata: {"type":"ping"}\n\n';
const previousConfig = getServerConfig() ?? DEFAULT_APP_CONFIG.proxy;

vi.mock('@/server/gateway/common/utils/request-user-agent', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveRequestUserAgent: async () => 'antigravity-timeout-test/0.0.0',
}));

async function createAnthropicStream(service: AnthropicService): Promise<Observable<string>> {
  return (await service.handleAnthropicMessages({
    max_tokens: 32,
    messages: [{ content: 'stream please', role: 'user' }],
    model: 'claude-sonnet-4-5',
    stream: true,
  } as never)) as Observable<string>;
}

function writeReadyFrame(stream: PassThrough): void {
  stream.write(createReadyFrame());
}

function createReadyFrame(text = 'ready'): Buffer {
  return Buffer.from(
    `data: ${JSON.stringify(
      geminiStreamFrame({
        candidates: [{ content: { parts: [{ text }], role: 'model' } }],
        modelVersion: 'gemini-3-flash',
        responseId: 'upstream-response-1',
      }),
    )}\n\n`,
  );
}

function createDeadlineUpstream(source: PassThrough) {
  vi.useFakeTimers();
  vi.spyOn(performance, 'now').mockImplementation(() => Date.now());
  setServerConfig({ ...DEFAULT_APP_CONFIG.proxy, generation_timeout: 480 });
  const upstream = createUpstream({ streamFrames: [] });
  upstream.streamGenerateInternal.mockImplementation(
    async (_body, _token, _proxy, _headers, signal) => {
      if (!signal) {
        throw new Error('Expected generation cancellation to reach the upstream.');
      }
      startGenerationStreamAttempt(signal);
      return captureGeminiStreamResult(addAbortSignal(signal, source), {
        attempt: null,
        responseHeaders: undefined,
        status: 200,
        outcome: 'completed',
        validateSignatures: true,
        signal,
      });
    },
  );
  return upstream;
}

describe('Anthropic stream timeout compatibility', () => {
  it('passes disconnect cancellation to the upstream preflight and stops account rotation', async () => {
    const stream = new PassThrough();
    const upstream = createUpstream({ streamFrames: [] });
    const controller = new AbortController();
    upstream.streamGenerateInternal.mockImplementation(
      async (_body, _token, _proxy, _headers, signal) => {
        expect(signal?.aborted).toBe(false);
        expect(signal).toBeInstanceOf(AbortSignal);
        signal?.addEventListener('abort', () => stream.destroy(new Error('synthetic disconnect')), {
          once: true,
        });
        return stream;
      },
    );
    const lease = createLease([createAccount('acc-1'), createAccount('acc-2')]);
    const service = createGateway(upstream, lease).anthropicService;
    const pending = service.handleAnthropicMessages(
      {
        model: 'claude-sonnet-4-5',
        max_tokens: 32,
        messages: [{ role: 'user', content: 'synthetic cancellation' }],
        stream: true,
      },
      undefined,
      controller.signal,
    );
    const rejected = expect(pending).rejects.toThrow(/cancelled/iu);
    await vi.waitFor(() => expect(upstream.streamGenerateInternal).toHaveBeenCalledOnce());
    controller.abort();
    await rejected;
    expect(stream.destroyed).toBe(true);
    expect(upstream.streamGenerateInternal).toHaveBeenCalledOnce();
    expect(lease.markModelSuccess).not.toHaveBeenCalled();
  });

  it('rejects an already cancelled Messages request before selecting an account', async () => {
    const upstream = createUpstream({ streamFrames: [] });
    const lease = createLease([createAccount('acc-1')]);
    const service = createGateway(upstream, lease).anthropicService;
    const controller = new AbortController();
    controller.abort();
    await expect(
      service.handleAnthropicMessages(
        {
          model: 'claude-sonnet-4-5',
          max_tokens: 32,
          messages: [{ role: 'user', content: 'synthetic cancellation' }],
        },
        undefined,
        controller.signal,
      ),
    ).rejects.toThrow(/cancelled/iu);
    expect(upstream.generateInternal).not.toHaveBeenCalled();
    expect(upstream.streamGenerateInternal).not.toHaveBeenCalled();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    setServerConfig(previousConfig);
  });

  it('expires the initial output window for heartbeat-only preflight without rotating accounts', async () => {
    const source = new PassThrough();
    const upstream = createDeadlineUpstream(source);
    const lease = createLease([createAccount('acc-1'), createAccount('acc-2')]);
    const request = createAnthropicStream(createGateway(upstream, lease).anthropicService);
    const settled = vi.fn();
    void request.then(settled, settled);
    const expired = expect(request).rejects.toMatchObject({
      name: 'GenerationDeadlineExceededError',
    });
    try {
      await vi.advanceTimersByTimeAsync(100_000);
      source.write(': upstream-heartbeat\n\n');
      await vi.advanceTimersByTimeAsync(79_999);
      expect(settled).not.toHaveBeenCalled();
      expect(upstream.streamGenerateInternal).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(1);
      await expired;
      expect(upstream.streamGenerateInternal).toHaveBeenCalledOnce();
      expect(lease.markFromUpstreamError).not.toHaveBeenCalled();
      expect(lease.markModelSuccess).not.toHaveBeenCalled();
      expect(source.destroyed).toBe(true);
    } finally {
      source.destroy();
    }
  });

  it('accepts a meaningful mapped event immediately before the initial output deadline', async () => {
    const upstreamStream = new PassThrough();
    const upstream = createDeadlineUpstream(upstreamStream);
    const lease = createLease([createAccount('acc-1'), createAccount('acc-2')]);
    const request = createAnthropicStream(createGateway(upstream, lease).anthropicService);

    await vi.advanceTimersByTimeAsync(179_999);
    writeReadyFrame(upstreamStream);
    const observable = await request;

    expect(upstream.streamGenerateInternal).toHaveBeenCalledTimes(1);
    expect(lease.markModelSuccess).not.toHaveBeenCalled();
    observable.subscribe().unsubscribe();
  });

  it('rotates accounts when the upstream errors after a ping and before a mapped event', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const firstStream = new PassThrough();
    const secondStream = new PassThrough();
    secondStream.write(createReadyFrame('recovered'));
    const upstream = createUpstream({ streamFrames: [] });
    upstream.streamGenerateInternal.mockImplementation(async (body, accessToken) => {
      upstream.calls.push({ accessToken, body, kind: 'stream' });
      return accessToken === 'access-acc-1' ? firstStream : secondStream;
    });
    const lease = createLease([createAccount('acc-1'), createAccount('acc-2')]);
    const request = createAnthropicStream(createGateway(upstream, lease).anthropicService);

    await vi.advanceTimersByTimeAsync(20_001);
    expect(upstream.calls.map((call) => call.accessToken)).toEqual(['access-acc-1']);
    firstStream.destroy(new Error('preflight stream failure'));
    await vi.advanceTimersByTimeAsync(1_000);
    const observable = await request;

    expect(upstream.calls.map((call) => call.accessToken)).toEqual([
      'access-acc-1',
      'access-acc-2',
    ]);
    expect(lease.markModelSuccess).not.toHaveBeenCalled();
    observable.subscribe().unsubscribe();
  });

  it('finalizes partial output at EOF without a finish reason', async () => {
    const upstreamStream = new PassThrough();
    const upstream = createUpstream({ streamFrames: [] });
    upstream.streamGenerateInternal.mockResolvedValue(upstreamStream);
    const lease = createLease([createAccount('acc-1')]);
    writeReadyFrame(upstreamStream);
    const observable = await createAnthropicStream(createGateway(upstream, lease).anthropicService);
    const chunks: string[] = [];
    const finished = new Promise<void>((resolve, reject) => {
      observable.subscribe({
        next: (chunk) => chunks.push(chunk),
        error: reject,
        complete: resolve,
      });
    });
    upstreamStream.end();
    await finished;

    expect(chunks.filter((chunk) => chunk.includes('event: error'))).toEqual([]);
    expect(chunks.join('')).toContain('"stop_reason":"max_tokens"');
    expect(chunks.filter((chunk) => chunk.includes('event: message_stop'))).toHaveLength(1);
    expect(lease.markModelSuccess).not.toHaveBeenCalled();
  });

  it.each([
    { activity: 'silence', frame: null, deadline: 300_000 },
    { activity: 'a heartbeat', frame: ': upstream-heartbeat\n\n', deadline: 300_000 },
    { activity: 'usage only', frame: 'data: {"usageMetadata":{}}\n\n', deadline: 300_000 },
    { activity: 'new mapped text', frame: createReadyFrame('more output'), deadline: 380_000 },
  ])('applies the activity and transition windows after $activity', async ({ frame, deadline }) => {
    const source = new PassThrough();
    const upstream = createDeadlineUpstream(source);
    const lease = createLease([createAccount('acc-1')]);
    writeReadyFrame(source);
    const observable = await createAnthropicStream(createGateway(upstream, lease).anthropicService);
    const chunks: string[] = [];
    const complete = vi.fn();
    const error = vi.fn();
    const subscription = observable.subscribe({
      next: (chunk) => chunks.push(chunk),
      complete,
      error,
    });

    try {
      await vi.advanceTimersByTimeAsync(80_000);
      if (frame !== null) {
        source.write(frame);
      } else {
        expect(chunks.filter((chunk) => chunk === ping)).toHaveLength(4);
      }

      await vi.advanceTimersByTimeAsync(deadline - 80_001);
      expect(error).not.toHaveBeenCalled();
      expect(complete).not.toHaveBeenCalled();
      expect(source.destroyed).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(error).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ name: 'GenerationDeadlineExceededError', code: 'ETIMEDOUT' }),
      );
      expect(complete).not.toHaveBeenCalled();
      expect(source.destroyed).toBe(true);
      expect(lease.markFromUpstreamError).not.toHaveBeenCalled();
      expect(lease.markModelSuccess).not.toHaveBeenCalled();
      expect(upstream.streamGenerateInternal).toHaveBeenCalledOnce();
      expect(chunks.some((chunk) => chunk.includes('event: message_stop'))).toBe(false);
    } finally {
      subscription.unsubscribe();
      source.destroy();
    }
  });

  it('destroys the upstream stream when the downstream unsubscribes', async () => {
    vi.useFakeTimers();
    const upstreamStream = new PassThrough();
    const upstream = createUpstream({ streamFrames: [] });
    upstream.streamGenerateInternal.mockResolvedValue(upstreamStream);
    const lease = createLease([createAccount('acc-1')]);
    writeReadyFrame(upstreamStream);
    const observable = await createAnthropicStream(createGateway(upstream, lease).anthropicService);

    const subscription = observable.subscribe();
    subscription.unsubscribe();

    expect(upstreamStream.destroyed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('finalizes partial output when the upstream closes before emitting end', async () => {
    vi.useFakeTimers();
    const upstreamStream = new PassThrough();
    const upstream = createUpstream({ streamFrames: [] });
    upstream.streamGenerateInternal.mockResolvedValue(upstreamStream);
    const lease = createLease([createAccount('acc-1')]);
    writeReadyFrame(upstreamStream);
    const observable = await createAnthropicStream(createGateway(upstream, lease).anthropicService);
    const chunks: string[] = [];
    const failure = new Promise<void>((resolve, reject) => {
      observable.subscribe({
        error: reject,
        complete: resolve,
        next: (chunk) => chunks.push(chunk),
      });
    });

    upstreamStream.emit('close');
    await failure;

    expect(chunks.join('')).toContain('"stop_reason":"max_tokens"');
    expect(chunks.filter((chunk) => chunk.startsWith('event: error'))).toEqual([]);
    expect(chunks.filter((chunk) => chunk.includes('event: message_stop'))).toHaveLength(1);
    expect(lease.markModelSuccess).not.toHaveBeenCalled();
    expect(upstreamStream.destroyed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reports one upstream error and clears the stream timers', async () => {
    vi.useFakeTimers();
    const upstreamStream = new PassThrough();
    const upstream = createUpstream({ streamFrames: [] });
    upstream.streamGenerateInternal.mockResolvedValue(upstreamStream);
    const lease = createLease([createAccount('acc-1')]);
    writeReadyFrame(upstreamStream);
    const observable = await createAnthropicStream(createGateway(upstream, lease).anthropicService);
    const chunks: string[] = [];
    const failure = new Promise<void>((resolve, reject) => {
      observable.subscribe({
        error: reject,
        complete: resolve,
        next: (chunk) => chunks.push(chunk),
      });
    });

    upstreamStream.emit('error', new Error('synthetic upstream failure'));
    await failure;

    expect(chunks.join('')).toContain('synthetic upstream failure');
    expect(chunks.filter((chunk) => chunk.startsWith('event: error'))).toHaveLength(1);
    expect(chunks.join('')).not.toContain('message_stop');
    expect(vi.getTimerCount()).toBe(0);
    upstreamStream.emit('close');
  });
});
