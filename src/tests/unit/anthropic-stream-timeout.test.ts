import { PassThrough } from 'node:stream';

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Observable } from 'rxjs';

import type { AnthropicService } from '@/modules/proxy-gateway/server/modules/anthropic/anthropic.service';
import {
  createAccount,
  createGateway,
  createLease,
  createUpstream,
  geminiStreamFrame,
} from './proxy-real-path.harness';

vi.mock(
  '@/modules/proxy-gateway/server/common/utils/request-user-agent',
  async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    resolveRequestUserAgent: async () => 'antigravity-timeout-test/0.0.0',
  }),
);

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

describe('Anthropic stream timeout compatibility', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('keeps a heartbeat-only preflight pending, then rotates accounts at 30 seconds', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const firstStream = new PassThrough();
    const secondStream = new PassThrough();
    secondStream.write(createReadyFrame('second account'));
    const upstream = createUpstream({ streamFrames: [] });
    upstream.streamGenerateInternal.mockImplementation(async (body, accessToken) => {
      upstream.calls.push({ accessToken, body, kind: 'stream' });
      return accessToken === 'access-acc-1' ? firstStream : secondStream;
    });
    const lease = createLease([createAccount('acc-1'), createAccount('acc-2')]);
    const request = createAnthropicStream(createGateway(upstream, lease).anthropicService);
    let settled = false;
    void request.finally(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(10_000);
    firstStream.write(': upstream-heartbeat\n\n');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(settled).toBe(false);
    expect(upstream.calls.map((call) => call.accessToken)).toEqual(['access-acc-1']);

    await vi.advanceTimersByTimeAsync(11_000);
    const observable = await request;
    const delivered: string[] = [];
    const subscription = observable.subscribe((chunk) => delivered.push(chunk));

    expect(upstream.calls.map((call) => call.accessToken)).toEqual([
      'access-acc-1',
      'access-acc-2',
    ]);
    expect(lease.markModelSuccess.mock.calls.map(([accountId]) => accountId)).toEqual(['acc-2']);
    expect(delivered).not.toContain(': ping\n\n');
    expect(firstStream.destroyed).toBe(true);
    subscription.unsubscribe();
  });

  it('accepts a meaningful mapped event immediately before the 30-second deadline', async () => {
    vi.useFakeTimers();
    const upstreamStream = new PassThrough();
    const upstream = createUpstream({ streamFrames: [] });
    upstream.streamGenerateInternal.mockResolvedValue(upstreamStream);
    const lease = createLease([createAccount('acc-1'), createAccount('acc-2')]);
    const request = createAnthropicStream(createGateway(upstream, lease).anthropicService);

    await vi.advanceTimersByTimeAsync(29_999);
    writeReadyFrame(upstreamStream);
    const observable = await request;

    expect(upstream.streamGenerateInternal).toHaveBeenCalledTimes(1);
    expect(lease.markModelSuccess.mock.calls.map(([accountId]) => accountId)).toEqual(['acc-1']);
    observable.subscribe().unsubscribe();
  });

  it('rotates accounts when the upstream errors before a meaningful mapped event', async () => {
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

    firstStream.destroy(new Error('preflight stream failure'));
    await vi.advanceTimersByTimeAsync(1_000);
    const observable = await request;

    expect(upstream.calls.map((call) => call.accessToken)).toEqual([
      'access-acc-1',
      'access-acc-2',
    ]);
    expect(lease.markModelSuccess.mock.calls.map(([accountId]) => accountId)).toEqual(['acc-2']);
    observable.subscribe().unsubscribe();
  });

  it('emits 20-second pings and aborts after five consecutive idle intervals', async () => {
    vi.useFakeTimers();
    const hangingStream = new PassThrough();
    const upstream = createUpstream({ streamFrames: [] });
    upstream.streamGenerateInternal.mockResolvedValue(hangingStream);
    const lease = createLease([createAccount('acc-1')]);
    writeReadyFrame(hangingStream);
    const service = createGateway(upstream, lease).anthropicService;
    const idleTimerSpy = vi.spyOn(
      service as unknown as {
        createStreamIdleTimer: (...args: unknown[]) => unknown;
      },
      'createStreamIdleTimer',
    );
    const observable = await createAnthropicStream(service);
    const chunks: string[] = [];
    let completed = false;

    observable.subscribe({
      complete: () => {
        completed = true;
      },
      next: (chunk) => chunks.push(chunk),
    });

    for (let interval = 1; interval < 5; interval++) {
      await vi.advanceTimersByTimeAsync(20_000);
      const pings = chunks.filter((chunk) => chunk === ': ping\n\n');
      expect(pings).toHaveLength(interval);
      expect(completed).toBe(false);
    }

    await vi.advanceTimersByTimeAsync(20_000);
    expect(completed).toBe(true);
    expect(
      chunks.filter((chunk) => chunk === ': ping\n\n' || chunk.includes('data: [DONE]')),
    ).toEqual([
      ': ping\n\n',
      ': ping\n\n',
      ': ping\n\n',
      ': ping\n\n',
      'data: {"type": "message_stop"}\n\ndata: [DONE]\n\n',
    ]);
    expect(hangingStream.destroyed).toBe(true);
    expect(idleTimerSpy.mock.calls[0]?.[3]).toBe(120_000);
  });

  it('resets the consecutive ping counter whenever upstream data arrives', async () => {
    vi.useFakeTimers();
    const hangingStream = new PassThrough();
    const upstream = createUpstream({ streamFrames: [] });
    upstream.streamGenerateInternal.mockResolvedValue(hangingStream);
    const lease = createLease([createAccount('acc-1')]);
    writeReadyFrame(hangingStream);
    const observable = await createAnthropicStream(createGateway(upstream, lease).anthropicService);
    let completed = false;

    observable.subscribe({
      complete: () => {
        completed = true;
      },
    });

    await vi.advanceTimersByTimeAsync(80_000);
    hangingStream.write('data: {}\n\n');
    await vi.advanceTimersByTimeAsync(80_000);
    expect(completed).toBe(false);

    await vi.advanceTimersByTimeAsync(20_000);
    expect(completed).toBe(true);
    expect(hangingStream.destroyed).toBe(true);
  });

  it('does not let raw upstream heartbeats extend the 120-second mapped-output guard', async () => {
    vi.useFakeTimers();
    const upstreamStream = new PassThrough();
    const upstream = createUpstream({ streamFrames: [] });
    upstream.streamGenerateInternal.mockResolvedValue(upstreamStream);
    const lease = createLease([createAccount('acc-1')]);
    writeReadyFrame(upstreamStream);
    const observable = await createAnthropicStream(createGateway(upstream, lease).anthropicService);
    const chunks: string[] = [];
    let completed = false;
    observable.subscribe({
      complete: () => {
        completed = true;
      },
      next: (chunk) => chunks.push(chunk),
    });
    const readyChunkCount = chunks.length;

    for (let heartbeat = 0; heartbeat < 11; heartbeat++) {
      await vi.advanceTimersByTimeAsync(10_000);
      upstreamStream.write(': upstream-heartbeat\n\n');
    }
    await vi.advanceTimersByTimeAsync(9_999);

    expect(completed).toBe(false);
    expect(chunks).toHaveLength(readyChunkCount);

    await vi.advanceTimersByTimeAsync(1);

    expect(completed).toBe(true);
    expect(chunks.filter((chunk) => chunk === ': ping\n\n')).toEqual([]);
    expect(chunks.filter((chunk) => chunk.includes('data: [DONE]'))).toHaveLength(1);
    expect(upstreamStream.destroyed).toBe(true);
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
});
