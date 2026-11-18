import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { FastifyReply } from 'fastify';
import { Observable } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getObservableFlowControl } from '@/server/gateway/common/observable-flow-control';
import { writeProxySseResponse } from '@/server/gateway/common/proxy-sse-response';
import { getSseOutputRetainedBytes } from '@/server/gateway/common/sse-output-pump';
import {
  createAccount,
  createGateway,
  createLease,
  createUpstream,
} from './proxy-real-path.harness';

type Protocol = 'chat' | 'responses' | 'messages' | 'gemini';
const anthropicPing = 'event: ping\ndata: {"type":"ping"}\n\n';

function frame(finish = false): string {
  return `data: ${JSON.stringify({
    response: {
      candidates: [
        {
          content: { role: 'model', parts: [{ text: 'controlled progress' }] },
          ...(finish ? { finishReason: 'STOP' } : {}),
        },
      ],
    },
  })}\n\n`;
}

async function createProtocolStream(protocol: Protocol) {
  const source = new PassThrough();
  const upstream = createUpstream({ streamFrames: [] });
  upstream.streamGenerateInternal.mockResolvedValue(source);
  const lease = createLease([createAccount('flow-account')]);
  const gateway = createGateway(upstream, lease);
  source.write(frame());
  const pending =
    protocol === 'gemini'
      ? gateway.geminiService.handleGeminiStreamGenerateContent('gemini-3-flash', {
          contents: [{ role: 'user', parts: [{ text: 'controlled flow' }] }],
        })
      : protocol === 'messages'
        ? gateway.anthropicService.handleAnthropicMessages({
            model: 'claude-sonnet-4-5',
            max_tokens: 32,
            stream: true,
            messages: [{ role: 'user', content: 'controlled flow' }],
          })
        : gateway.openAIService.handleChatCompletions(
            {
              model: 'gemini-3-flash',
              stream: true,
              messages: [{ role: 'user', content: 'controlled flow' }],
            },
            protocol === 'responses' ? 'responses' : 'chat-completions',
          );
  await vi.advanceTimersByTimeAsync(0);
  const stream = await pending;
  if (!(stream instanceof Observable)) {
    throw new Error('Expected production protocol stream');
  }
  return { source, lease, upstream, stream };
}

async function createBackpressuredResponse(protocol: Protocol) {
  const { source, lease, upstream, stream } = await createProtocolStream(protocol);
  const chunks: string[] = [];
  let blocked = true;
  const raw = Object.assign(new EventEmitter(), {
    writableEnded: false,
    writableFinished: false,
    destroyed: false,
    writableLength: 0,
    writeHead: vi.fn(),
    write: vi.fn((chunk: string | Buffer) => {
      chunks.push(chunk.toString());
      return !blocked;
    }),
    end: vi.fn(() => {
      raw.writableEnded = true;
      raw.writableFinished = true;
      raw.emit('close');
    }),
    destroy: vi.fn(() => {
      raw.destroyed = true;
      raw.emit('close');
      return raw;
    }),
  });
  const resume = vi.spyOn(source, 'resume');
  writeProxySseResponse({ raw, hijack: vi.fn() } as unknown as FastifyReply, stream);
  await vi.advanceTimersByTimeAsync(0);
  expect(raw.write).toHaveBeenCalled();
  expect(source.isPaused()).toBe(true);
  return {
    source,
    lease,
    upstream,
    raw,
    chunks,
    resume,
    drain: async () => {
      blocked = false;
      raw.emit('drain');
      await vi.advanceTimersByTimeAsync(0);
    },
    close: () => {
      raw.emit('close');
      source.destroy();
    },
  };
}

afterEach(() => {
  expect(getSseOutputRetainedBytes()).toBe(0);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('protocol heartbeats during downstream backpressure', () => {
  describe.each(['close', 'EOF'] as const)('upstream %s while paused', (ending) => {
    it.each([
      ['chat', 'data: [DONE]', '"finish_reason":"length"'],
      ['responses', 'event: response.failed', '"status":"failed"'],
      ['messages', 'event: message_stop', '"stop_reason":"max_tokens"'],
      ['gemini', '"finishReason":"MAX_TOKENS"', '"gatewayInterrupted"'],
    ] as const)(
      'terminates %s once without recording successful completion',
      async (protocol, terminalFrame, interruption) => {
        vi.useFakeTimers();
        const response = await createBackpressuredResponse(protocol);
        try {
          if (ending === 'close') {
            response.source.destroy();
          } else {
            response.source.end();
          }
          await vi.advanceTimersByTimeAsync(0);
          expect(response.raw.end).not.toHaveBeenCalled();
          await response.drain();
          const output = response.chunks.join('');
          expect(output.split(terminalFrame)).toHaveLength(2);
          expect(output).toContain(interruption);
          if (protocol === 'responses' && ending === 'close') {
            // The socket closes while Responses is paused on its opening event.
            expect(output).not.toContain('event: response.output_text.delta');
          } else {
            expect(output).toContain('controlled progress');
          }
          expect(output).not.toContain('event: response.completed');
          expect(output).not.toContain('"finishReason":"STOP"');
          expect(response.raw.end).toHaveBeenCalledOnce();
          expect(response.lease.markModelSuccess).not.toHaveBeenCalled();
          expect(response.upstream.streamGenerateInternal).toHaveBeenCalledOnce();
          const delivered = [...response.chunks];
          response.source.emit('data', Buffer.from(frame(true)));
          response.source.emit('end');
          response.source.emit('close');
          response.raw.emit('drain');
          await vi.advanceTimersByTimeAsync(300_000);
          expect(response.chunks).toEqual(delivered);
          expect(response.raw.end).toHaveBeenCalledOnce();
          expect(response.lease.markModelSuccess).not.toHaveBeenCalled();
          expect(vi.getTimerCount()).toBe(0);
        } finally {
          response.close();
        }
      },
    );
  });

  it.each(['chat', 'responses', 'messages', 'gemini'] as const)(
    'cancels %s when a blocked client never drains',
    async (protocol) => {
      vi.useFakeTimers();
      const response = await createBackpressuredResponse(protocol);
      try {
        await vi.advanceTimersByTimeAsync(29_999);
        expect(response.raw.destroy).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(response.raw.destroy).toHaveBeenCalledOnce();
        expect(response.raw.end).not.toHaveBeenCalled();
        expect(response.source.destroyed).toBe(true);
        expect(getSseOutputRetainedBytes()).toBe(0);
        const delivered = [...response.chunks];
        response.raw.emit('drain');
        await vi.advanceTimersByTimeAsync(300_000);
        expect(response.chunks).toEqual(delivered);
        expect(response.lease.markModelSuccess).not.toHaveBeenCalled();
        expect(response.upstream.streamGenerateInternal).toHaveBeenCalledOnce();
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        response.close();
      }
    },
  );

  it.each([
    ['chat', 'data: [DONE]'],
    ['responses', 'event: response.completed'],
    ['messages', 'event: message_stop'],
    ['gemini', '"finishReason":"STOP"'],
  ] as const)(
    'finishes %s once after draining buffered upstream completion',
    async (protocol, terminal) => {
      vi.useFakeTimers();
      const response = await createBackpressuredResponse(protocol);
      try {
        response.source.end(frame(true));
        await vi.advanceTimersByTimeAsync(0);
        expect(response.raw.end).not.toHaveBeenCalled();
        await response.drain();
        expect(response.chunks.join('').split(terminal)).toHaveLength(2);
        expect(response.raw.end).toHaveBeenCalledOnce();
        expect(response.lease.markModelSuccess).toHaveBeenCalledOnce();
        const delivered = [...response.chunks];
        response.source.emit('data', Buffer.from(frame(true)));
        response.source.emit('end');
        response.source.emit('close');
        response.raw.emit('drain');
        await vi.advanceTimersByTimeAsync(300_000);
        expect(response.chunks).toEqual(delivered);
        expect(response.raw.end).toHaveBeenCalledOnce();
        expect(response.upstream.streamGenerateInternal).toHaveBeenCalledOnce();
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        response.close();
      }
    },
  );

  it.each(['chat', 'responses', 'messages', 'gemini'] as const)(
    'delivers one %s failure after a paused upstream transport error',
    async (protocol) => {
      vi.useFakeTimers();
      const response = await createBackpressuredResponse(protocol);
      try {
        response.source.destroy(new Error('controlled upstream failure'));
        await vi.advanceTimersByTimeAsync(0);
        expect(response.raw.end).not.toHaveBeenCalled();
        await response.drain();
        const output = response.chunks.join('');
        const message =
          protocol === 'messages'
            ? 'controlled upstream failure'
            : 'Upstream response stream failed.';
        expect(output.split(message)).toHaveLength(2);
        expect(output).not.toContain('data: [DONE]');
        expect(output).not.toContain('event: response.completed');
        expect(output).not.toContain('event: message_stop');
        expect(response.raw.end).toHaveBeenCalledOnce();
        expect(response.lease.markModelSuccess).not.toHaveBeenCalled();
        expect(response.upstream.streamGenerateInternal).toHaveBeenCalledOnce();
        const delivered = [...response.chunks];
        response.source.emit('close');
        response.raw.emit('drain');
        await vi.advanceTimersByTimeAsync(300_000);
        expect(response.chunks).toEqual(delivered);
        expect(response.raw.end).toHaveBeenCalledOnce();
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        response.close();
      }
    },
  );

  it('terminates partial Anthropic output at the fifth idle interval while heartbeats are paused', async () => {
    vi.useFakeTimers();
    const { source, lease, upstream, stream } = await createProtocolStream('messages');
    const chunks: string[] = [];
    const complete = vi.fn();
    const subscription = stream.subscribe({ next: (chunk) => chunks.push(chunk), complete });
    try {
      await vi.advanceTimersByTimeAsync(0);
      const control = getObservableFlowControl(stream);
      expect(control).toBeDefined();
      control?.pause();
      const progress = [...chunks];
      await vi.advanceTimersByTimeAsync(99_999);
      expect(chunks).toEqual(progress);
      expect(complete).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(chunks.filter((chunk) => chunk === anthropicPing)).toEqual([]);
      expect(chunks.join('')).toContain('controlled progress');
      expect(chunks.join('')).toContain('"stop_reason":"max_tokens"');
      expect(chunks.filter((chunk) => chunk.includes('event: message_stop'))).toHaveLength(1);
      expect(chunks.at(-1)).toContain('event: message_stop');
      expect(complete).toHaveBeenCalledOnce();
      expect(source.destroyed).toBe(true);
      expect(lease.markModelSuccess).not.toHaveBeenCalled();
      expect(upstream.streamGenerateInternal).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(300_000);
      expect(complete).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      subscription.unsubscribe();
      source.destroy();
    }
  });

  it.each([
    ['chat', 3000],
    ['responses', 15000],
    ['messages', 20000],
  ] as const)(
    'does not enqueue %s heartbeats while blocked or replay missed ticks',
    async (protocol, interval) => {
      vi.useFakeTimers();
      const response = await createBackpressuredResponse(protocol);
      const ping = protocol === 'messages' ? anthropicPing : ': ping\n\n';
      try {
        const retained = getSseOutputRetainedBytes();
        const resumes = response.resume.mock.calls.length;
        await vi.advanceTimersByTimeAsync(21_000);
        expect(response.source.isPaused()).toBe(true);
        expect(response.resume).toHaveBeenCalledTimes(resumes);
        expect(getSseOutputRetainedBytes()).toBe(retained);
        await response.drain();
        expect(response.chunks.filter((chunk) => chunk === ping)).toEqual([]);
        await vi.advanceTimersByTimeAsync(interval);
        expect(response.chunks.filter((chunk) => chunk === ping)).toEqual([ping]);
        expect(response.upstream.streamGenerateInternal).toHaveBeenCalledOnce();
        expect(response.lease.markModelSuccess).not.toHaveBeenCalled();
      } finally {
        response.close();
      }
      await vi.advanceTimersByTimeAsync(300_000);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each(['chat', 'responses', 'messages', 'gemini'] as const)(
    'does not resume or write %s after a blocked client disconnects',
    async (protocol) => {
      vi.useFakeTimers();
      const response = await createBackpressuredResponse(protocol);
      response.close();
      const resumes = response.resume.mock.calls.length;
      const written = [...response.chunks];
      response.raw.emit('drain');
      response.source.emit('data', Buffer.from(frame(true)));
      await vi.advanceTimersByTimeAsync(300_000);
      expect(response.chunks).toEqual(written);
      expect(response.resume).toHaveBeenCalledTimes(resumes);
      expect(response.raw.listenerCount('drain')).toBe(0);
      expect(response.source.destroyed).toBe(true);
      expect(response.lease.markModelSuccess).not.toHaveBeenCalled();
      expect(response.upstream.streamGenerateInternal).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    },
  );
});
