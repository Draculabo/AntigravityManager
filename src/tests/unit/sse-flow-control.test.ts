import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { FastifyReply } from 'fastify';
import { Observable } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { writeProxySseResponse } from '@/server/gateway/common/proxy-sse-response';
import { FlowControlledSseStream } from '@/server/gateway/common/flow-controlled-sse-stream';
import {
  createAccount,
  createGateway,
  createLease,
  createUpstream,
} from './proxy-real-path.harness';

describe('production SSE producer backpressure', () => {
  it.each(['gemini', 'chat', 'responses', 'messages'] as const)(
    'pauses %s upstream when the socket fills and resumes it only after drain',
    async (protocol) => {
      const source = new PassThrough();
      const upstream = createUpstream({ streamFrames: [] });
      upstream.streamGenerateInternal.mockResolvedValue(source);
      const gateway = createGateway(upstream, createLease([createAccount('acc-1')]));
      const frame =
        'data: ' +
        JSON.stringify({
          response: {
            candidates: [{ content: { role: 'model', parts: [{ text: 'synthetic frame' }] } }],
          },
        }) +
        '\n\n';
      let stream: Observable<string>;
      if (protocol === 'gemini') {
        stream = await gateway.geminiService.handleGeminiStreamGenerateContent('gemini-3-flash', {
          contents: [{ role: 'user', parts: [{ text: 'synthetic flow' }] }],
        });
      } else if (protocol === 'messages') {
        const pending = gateway.anthropicService.handleAnthropicMessages({
          model: 'claude-sonnet-4-6-thinking',
          max_tokens: 32,
          stream: true,
          messages: [{ role: 'user', content: 'synthetic flow' }],
        });
        await vi.waitFor(() => expect(upstream.streamGenerateInternal).toHaveBeenCalledOnce());
        source.write(frame);
        const result = await pending;
        if (!(result instanceof Observable)) {
          throw new Error('Expected Messages stream');
        }
        stream = result;
      } else {
        const result = await gateway.openAIService.handleChatCompletions(
          {
            model: 'gemini-3-flash',
            stream: true,
            messages: [{ role: 'user', content: 'synthetic flow' }],
          },
          protocol === 'responses' ? 'responses' : 'chat-completions',
        );
        if (!(result instanceof Observable)) {
          throw new Error('Expected OpenAI stream');
        }
        stream = result;
      }
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
      const reply = { raw, hijack: vi.fn() } as unknown as FastifyReply;
      try {
        if (!(stream instanceof FlowControlledSseStream)) {
          throw new Error('Expected a flow-controlled protocol stream');
        }
        writeProxySseResponse(reply, stream);
        if (protocol !== 'messages') {
          source.write(frame);
        }
        await vi.waitFor(() => expect(stream.isPaused).toBe(true));
        expect(raw.write).toHaveBeenCalledOnce();
        source.write(frame);
        expect(raw.write).toHaveBeenCalledOnce();
        raw.write.mockReturnValue(true);
        raw.emit('drain');
        await vi.waitFor(() => {
          expect(stream.isPaused).toBe(false);
          const wire = raw.write.mock.calls.map(([chunk]) => chunk.toString()).join('');
          expect(wire).toContain('synthetic frame');
        });
      } finally {
        raw.emit('close');
        source.destroy();
      }
    },
  );
});
