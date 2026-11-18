import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { FastifyReply } from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { FlowControlledSseStream } from '@/server/gateway/common/flow-controlled-sse-stream';
import { writeProxySseResponse } from '@/server/gateway/common/proxy-sse-response';
import { OpenAIOperations } from '@/server/gateway/modules/openai/openai-operations.service';
import {
  createAccount,
  createGateway,
  createLease,
  createUpstream,
  geminiTextResponse,
} from './proxy-real-path.harness';

function createReply() {
  const raw = Object.assign(new EventEmitter(), {
    writableEnded: false,
    writableFinished: false,
    destroyed: false,
    writableLength: 0,
    writeHead: vi.fn(),
    write: vi.fn((_chunk: string | Buffer) => false),
    end: vi.fn(),
    destroy: vi.fn(() => {
      raw.destroyed = true;
      raw.emit('close');
      return raw;
    }),
  });
  return { raw, hijack: vi.fn() } as unknown as FastifyReply;
}

describe('secondary SSE producer ownership', () => {
  it.each(['gemini', 'chat-completions', 'responses', 'messages'] as const)(
    'fails %s explicitly before retaining an oversized unfinished SSE line',
    async (protocol) => {
      const source = new PassThrough();
      const upstream = createUpstream({ streamFrames: [] });
      upstream.streamGenerateInternal.mockResolvedValue(source);
      const gateway = createGateway(upstream, createLease([createAccount('acc-1')]));
      const first =
        'data: ' +
        JSON.stringify({
          response: { candidates: [{ content: { role: 'model', parts: [{ text: 'start' }] } }] },
        }) +
        '\n\n';
      let stream;
      if (protocol === 'gemini') {
        stream = await gateway.geminiService.handleGeminiStreamGenerateContent('gemini-3-flash', {
          contents: [{ role: 'user', parts: [{ text: 'fixture' }] }],
        });
      } else if (protocol === 'messages') {
        const pending = gateway.anthropicService.handleAnthropicMessages({
          model: 'claude-sonnet-4-5',
          stream: true,
          max_tokens: 32,
          messages: [{ role: 'user', content: 'fixture' }],
        });
        await vi.waitFor(() => expect(upstream.streamGenerateInternal).toHaveBeenCalledOnce());
        source.write(first);
        stream = await pending;
      } else {
        stream = await gateway.openAIService.handleChatCompletions(
          {
            model: 'gemini-3-flash',
            stream: true,
            messages: [{ role: 'user', content: 'fixture' }],
          },
          protocol,
        );
      }
      if (!(stream instanceof FlowControlledSseStream)) {
        throw new Error('Expected controlled stream');
      }
      const chunks: string[] = [];
      const completed = vi.fn();
      const subscription = stream.subscribe({
        next: (text) => chunks.push(String(text)),
        complete: completed,
      });
      try {
        const fragment = Buffer.from('x'.repeat(8 * 1024 * 1024));
        for (let i = 0; i < 9 && !source.destroyed; i++) {
          source.write(fragment);
        }
        expect(completed).toHaveBeenCalledOnce();
        expect(chunks.join('')).toContain('Upstream SSE line exceeds decode budget.');
        expect(chunks.join('')).not.toContain('[DONE]');
        expect(source.destroyed).toBe(true);
      } finally {
        subscription.unsubscribe();
        source.destroy();
      }
    },
  );
  it.each(['chat-completions', 'responses'] as const)(
    'pauses lazy %s fallback before constructing later frames',
    async (protocol) => {
      const upstream = createUpstream({
        streamError: new Error('controlled stream failure'),
        generate: geminiTextResponse('fallback'.repeat(1000)),
      });
      const gateway = createGateway(upstream, createLease([createAccount('acc-1')]));
      const stream = await gateway.openAIService.handleChatCompletions(
        { model: 'gemini-3-flash', stream: true, messages: [{ role: 'user', content: 'fixture' }] },
        protocol,
      );
      expect(stream).toBeInstanceOf(FlowControlledSseStream);
      if (!(stream instanceof FlowControlledSseStream)) {
        throw new Error('Expected flow-controlled fallback');
      }
      const reply = createReply();
      try {
        writeProxySseResponse(reply, stream);
        await vi.waitFor(() => expect(reply.raw.write).toHaveBeenCalled());
        expect(stream.isPaused).toBe(true);
        expect(reply.raw.write).toHaveBeenCalledTimes(1);
        vi.mocked(reply.raw.write).mockReturnValue(true);
        reply.raw.emit('drain');
        await vi.waitFor(() => expect(reply.raw.end).toHaveBeenCalledOnce());
      } finally {
        reply.raw.emit('close');
      }
    },
  );

  it('preserves upstream pause ownership through the HTTP Responses session wrapper', async () => {
    const source = new PassThrough();
    const stream = new FlowControlledSseStream(source, (subscriber) => {
      source.on('data', (chunk) => subscriber.next(String(chunk)));
      return () => source.destroy();
    });
    const operations = new OpenAIOperations({
      handleChatCompletions: vi.fn(async () => stream),
    } as never);
    const reply = createReply();
    try {
      await operations.responses(
        { input: 'fixture', model: 'fixture', stream: true, store: false },
        reply,
      );
      source.write('data: {"type":"response.created"}\n\n');
      expect(source.isPaused()).toBe(true);
      vi.mocked(reply.raw.write).mockReturnValue(true);
      reply.raw.emit('drain');
      expect(source.isPaused()).toBe(false);
    } finally {
      reply.raw.emit('close');
      source.destroy();
    }
  });
});
