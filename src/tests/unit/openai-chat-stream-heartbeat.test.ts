import { PassThrough } from 'node:stream';

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Observable } from 'rxjs';

import { MAX_SSE_EVENT_BYTES } from '@/modules/proxy-gateway/antigravity/internal-sse';
import type { OpenAIService } from '@/server/gateway/modules/openai/openai.service';
import {
  createAccount,
  createGateway,
  createLease,
  createUpstream,
} from './proxy-real-path.harness';

function createChatStream(
  service: OpenAIService,
  upstream: NodeJS.ReadableStream,
  imagePermit?: { release: () => void },
): Observable<string> {
  const method: unknown = Reflect.get(service, 'processStreamResponse');
  if (typeof method !== 'function') {
    throw new Error('Chat Completions stream processor is unavailable');
  }
  return Reflect.apply(method, service, [
    upstream,
    'gemini-3-pro',
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    imagePermit,
    undefined,
  ]) as Observable<string>;
}

function createResponsesStream(
  service: OpenAIService,
  upstream: NodeJS.ReadableStream,
  imagePermit?: { release: () => void },
): Observable<string> {
  const method: unknown = Reflect.get(service, 'processResponsesStreamResponse');
  if (typeof method !== 'function') {
    throw new Error('Responses stream processor is unavailable');
  }
  return Reflect.apply(method, service, [
    upstream,
    'gemini-3-pro',
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    imagePermit,
    'resp-heartbeat',
    undefined,
  ]) as Observable<string>;
}

describe('OpenAI Chat stream heartbeat', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('emits a three-second comment while the upstream stays silent', async () => {
    vi.useFakeTimers();
    const silentStream = new PassThrough();
    const upstream = createUpstream({ streamFrames: [] });
    upstream.streamGenerateInternal.mockResolvedValue(silentStream);
    const lease = createLease([createAccount('acc-1')]);
    const observable = createChatStream(createGateway(upstream, lease).openAIService, silentStream);

    const chunks: string[] = [];
    let completed = false;
    observable.subscribe({
      complete: () => {
        completed = true;
      },
      next: (chunk) => chunks.push(chunk),
    });

    for (let interval = 1; interval <= 3; interval++) {
      await vi.advanceTimersByTimeAsync(3_000);
      expect(chunks.filter((chunk) => chunk === ': ping\n\n')).toHaveLength(interval);
      expect(completed).toBe(false);
    }

    silentStream.end();
    await vi.advanceTimersByTimeAsync(0);
    expect(completed).toBe(true);
    expect(chunks.filter((chunk) => chunk === ': ping\n\n')).toHaveLength(3);
  });

  it('stops emitting comments once the stream completed', async () => {
    vi.useFakeTimers();
    const finishedStream = new PassThrough();
    finishedStream.write(
      `data: ${JSON.stringify({
        response: {
          candidates: [
            { content: { parts: [{ text: 'done' }], role: 'model' }, finishReason: 'STOP' },
          ],
          responseId: 'resp-heartbeat-1',
        },
      })}\n\n`,
    );
    finishedStream.end();
    const upstream = createUpstream({ streamFrames: [] });
    upstream.streamGenerateInternal.mockResolvedValue(finishedStream);
    const lease = createLease([createAccount('acc-1')]);
    const observable = createChatStream(
      createGateway(upstream, lease).openAIService,
      finishedStream,
    );

    const chunks: string[] = [];
    let completed = false;
    observable.subscribe({
      complete: () => {
        completed = true;
      },
      next: (chunk) => chunks.push(chunk),
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(completed).toBe(true);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(chunks.filter((chunk) => chunk === ': ping\n\n')).toHaveLength(0);
  });

  it('maps a multiline EOF-terminated internal SSE event', async () => {
    const upstreamStream = new PassThrough();
    const upstream = createUpstream({ streamFrames: [] });
    upstream.streamGenerateInternal.mockResolvedValue(upstreamStream);
    const service = createGateway(upstream, createLease([createAccount('acc-1')])).openAIService;
    const chunks: string[] = [];
    const completed = new Promise<void>((resolve, reject) => {
      createChatStream(service, upstreamStream).subscribe({
        complete: resolve,
        error: reject,
        next: (chunk) => chunks.push(chunk),
      });
    });

    upstreamStream.write('data: {"response":\n');
    upstreamStream.end(
      Buffer.from(
        'data: {"candidates":[{"content":{"parts":[{"text":"multiline answer"}]},"finishReason":"STOP"}]}}',
      ),
    );
    await completed;

    expect(chunks.join('')).toContain('multiline answer');
    expect(chunks.at(-1)).toBe('data: [DONE]\n\n');
  });

  it('reports incomplete UTF-8 at EOF as a stream decoding error', async () => {
    const upstreamStream = new PassThrough();
    const service = createGateway(
      createUpstream({ streamFrames: [] }),
      createLease([createAccount('acc-1')]),
    ).openAIService;
    const chunks: string[] = [];
    const completed = new Promise<void>((resolve, reject) => {
      createChatStream(service, upstreamStream).subscribe({
        complete: resolve,
        error: reject,
        next: (chunk) => chunks.push(chunk),
      });
    });

    upstreamStream.write(Buffer.from([0xe2, 0x82]));
    upstreamStream.end();
    await completed;

    expect(chunks.join('')).toContain('"code":"stream_decode_error"');
    expect(chunks.at(-1)).not.toBe('data: [DONE]\n\n');
  });

  it('rejects an unterminated SSE line that exceeds the retained-input budget', async () => {
    const upstreamStream = new PassThrough();
    const service = createGateway(
      createUpstream({ streamFrames: [] }),
      createLease([createAccount('acc-1')]),
    ).openAIService;
    const chunks: string[] = [];
    const completed = new Promise<void>((resolve, reject) => {
      createChatStream(service, upstreamStream).subscribe({
        complete: resolve,
        error: reject,
        next: (chunk) => chunks.push(chunk),
      });
    });

    upstreamStream.write(`data: ${'x'.repeat(MAX_SSE_EVENT_BYTES)}`);
    await completed;

    expect(chunks.join('')).toContain('Upstream SSE line exceeds decode budget.');
    expect(chunks.at(-1)).not.toBe('data: [DONE]\n\n');
  });

  it('keeps Responses on its existing fifteen-second heartbeat interval', async () => {
    vi.useFakeTimers();
    const silentStream = new PassThrough();
    const service = createGateway(
      createUpstream({ streamFrames: [] }),
      createLease([createAccount('acc-1')]),
    ).openAIService;
    const observable = createResponsesStream(service, silentStream);
    const chunks: string[] = [];
    observable.subscribe((chunk) => chunks.push(chunk));

    await vi.advanceTimersByTimeAsync(14_999);
    expect(chunks.filter((chunk) => chunk === ': ping\n\n')).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(chunks.filter((chunk) => chunk === ': ping\n\n')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(chunks.filter((chunk) => chunk === ': ping\n\n')).toHaveLength(2);

    silentStream.end();
  });

  it.each([
    ['Chat Completions', createChatStream],
    ['Responses', createResponsesStream],
  ])('does not let %s upstream comments extend the idle deadline', async (_label, createStream) => {
    vi.useFakeTimers();
    const silentStream = new PassThrough();
    const service = createGateway(
      createUpstream({ streamFrames: [] }),
      createLease([createAccount('acc-1')]),
    ).openAIService;
    const result = createStream(service, silentStream);
    const chunks: string[] = [];
    const completed = new Promise<void>((resolve, reject) => {
      result.subscribe({
        complete: resolve,
        error: reject,
        next: (chunk) => chunks.push(chunk),
      });
    });

    await vi.advanceTimersByTimeAsync(299_999);
    silentStream.write(': upstream-heartbeat\n\n');
    await vi.advanceTimersByTimeAsync(1);

    await completed;
    expect(chunks.join('')).toContain('upstream_timeout');
    expect(silentStream.destroyed).toBe(true);
  });

  it.each([
    ['Chat Completions', createChatStream],
    ['Responses', createResponsesStream],
  ])('extends the %s idle deadline after a valid response event', async (_label, createStream) => {
    vi.useFakeTimers();
    const upstreamStream = new PassThrough();
    const service = createGateway(
      createUpstream({ streamFrames: [] }),
      createLease([createAccount('acc-1')]),
    ).openAIService;
    const chunks: string[] = [];
    let completed = false;
    const done = new Promise<void>((resolve, reject) => {
      createStream(service, upstreamStream).subscribe({
        complete: () => {
          completed = true;
          resolve();
        },
        error: reject,
        next: (chunk) => chunks.push(chunk),
      });
    });

    await vi.advanceTimersByTimeAsync(299_999);
    upstreamStream.write(
      `data: ${JSON.stringify({
        response: { candidates: [{ content: { parts: [{ text: 'partial' }] } }] },
      })}\n\n`,
    );
    await vi.advanceTimersByTimeAsync(299_999);
    expect(completed).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await done;

    expect(completed).toBe(true);
    expect(chunks.join('')).toContain('partial');
    if (_label === 'Chat Completions') {
      expect(chunks.join('')).toContain('"finish_reason":"length"');
      expect(chunks.at(-1)).toBe('data: [DONE]\n\n');
    } else {
      expect(chunks.join('')).toContain('upstream_timeout');
    }
    expect(upstreamStream.destroyed).toBe(true);
  });

  it.each([
    ['Chat Completions', createChatStream],
    ['Responses', createResponsesStream],
  ])('ignores late %s events after unsubscribe and releases once', (_label, createStream) => {
    vi.useFakeTimers();
    const upstreamStream = new PassThrough();
    const service = createGateway(
      createUpstream({ streamFrames: [] }),
      createLease([createAccount('acc-1')]),
    ).openAIService;
    const release = vi.fn();
    const subscription = createStream(service, upstreamStream, { release }).subscribe();

    subscription.unsubscribe();
    upstreamStream.emit(
      'data',
      Buffer.from(
        `data: ${JSON.stringify({
          response: { candidates: [{ content: { parts: [{ text: 'late' }] } }] },
        })}\n\n`,
      ),
    );
    upstreamStream.emit('error', new Error('late upstream failure'));

    expect(upstreamStream.destroyed).toBe(true);
    expect(release).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    ['Chat Completions', createChatStream],
    ['Responses', createResponsesStream],
  ])('terminates %s when the upstream closes before end', async (_label, createStream) => {
    vi.useFakeTimers();
    const upstreamStream = new PassThrough();
    const service = createGateway(
      createUpstream({ streamFrames: [] }),
      createLease([createAccount('acc-1')]),
    ).openAIService;
    const release = vi.fn();
    const chunks: string[] = [];
    const done = new Promise<void>((resolve, reject) => {
      createStream(service, upstreamStream, { release }).subscribe({
        complete: resolve,
        error: reject,
        next: (chunk) => chunks.push(chunk),
      });
    });

    upstreamStream.emit('close');
    await done;

    expect(chunks.join('')).toContain('upstream_interrupted');
    expect(chunks.join('')).toContain('closed before completion');
    expect(chunks.join('')).not.toContain('[DONE]');
    expect(release).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    ['Chat Completions', createChatStream],
    ['Responses', createResponsesStream],
  ])('maps one %s upstream error and releases the permit once', async (_label, createStream) => {
    vi.useFakeTimers();
    const upstreamStream = new PassThrough();
    const service = createGateway(
      createUpstream({ streamFrames: [] }),
      createLease([createAccount('acc-1')]),
    ).openAIService;
    const release = vi.fn();
    const chunks: string[] = [];
    const done = new Promise<void>((resolve, reject) => {
      createStream(service, upstreamStream, { release }).subscribe({
        complete: resolve,
        error: reject,
        next: (chunk) => chunks.push(chunk),
      });
    });

    upstreamStream.emit('error', new Error('synthetic upstream failure'));
    await done;
    upstreamStream.emit('close');

    expect(chunks.join('')).toContain('upstream_stream_error');
    expect(chunks.join('')).toContain('Upstream response stream failed.');
    expect(chunks.join('')).not.toContain('[DONE]');
    expect(release).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});
