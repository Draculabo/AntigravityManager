import { Readable } from 'node:stream';
import { Logger } from '@nestjs/common';
import { Observable } from 'rxjs';
import { z } from 'zod';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createAccount,
  createGateway,
  createLease,
  createUpstream,
} from './proxy-real-path.harness';
import { OpenAIResponsesSessionStore } from '@/server/gateway/modules/openai/responses/openai-responses-session.store';
import { UpstreamThoughtSignatureConflictError } from '@/server/gateway/common/upstream-thought-signature-validation';
import { GenerationDeadlineExceededError } from '@/server/gateway/common/exceptions/generation-deadline.exception';

vi.mock('@/server/gateway/common/utils/request-user-agent', () => ({
  resolveRequestUserAgent: async () => 'controlled-public-stream-test/0.0.0',
  buildContentRequestUserAgent: () => 'controlled-public-stream-test/0.0.0',
  resolveLocalInstalledVersion: () => '0.0.0',
}));

type Protocol = 'chat' | 'responses' | 'messages' | 'gemini';
const partial = {
  response: {
    candidates: [{ content: { role: 'model', parts: [{ text: 'controlled partial' }] } }],
    usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 3, totalTokenCount: 10 },
  },
};
const done = { response: { candidates: [{ finishReason: 'STOP' }] } };
const frame = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;

async function run(protocol: Protocol, chunks: string[], transportError?: Error) {
  const source = Readable.from(
    (function* () {
      yield* chunks.map((chunk) => Buffer.from(chunk));
      if (transportError) {
        throw transportError;
      }
    })(),
  );
  const upstream = createUpstream({});
  upstream.streamGenerateInternal.mockResolvedValue(source);
  const lease = createLease([createAccount('public-stream-controlled')]);
  const gateway = createGateway(upstream, lease);
  let stream;
  if (protocol === 'gemini') {
    stream = await gateway.geminiService.handleGeminiStreamGenerateContent('gemini-3-flash', {
      contents: [{ role: 'user', parts: [{ text: 'controlled' }] }],
    });
  } else if (protocol === 'messages') {
    stream = await gateway.anthropicService.handleAnthropicMessages({
      model: 'claude-sonnet-4-5',
      max_tokens: 32,
      stream: true,
      messages: [{ role: 'user', content: 'controlled' }],
    });
  } else {
    stream = await gateway.openAIService.handleChatCompletions(
      {
        model: 'gemini-3-flash',
        stream: true,
        stream_options: { include_usage: true },
        messages: [{ role: 'user', content: 'controlled' }],
      },
      protocol === 'responses' ? 'responses' : 'chat-completions',
    );
  }
  if (!(stream instanceof Observable)) {
    throw new Error('Expected production stream');
  }
  const output: string[] = [];
  await new Promise<void>((resolve, reject) => {
    stream.subscribe({
      next: (value: string) => output.push(value),
      error: reject,
      complete: resolve,
    });
  });
  return { output: output.join(''), upstream, lease };
}

function publicError(protocol: Protocol, output: string): unknown {
  const events = output
    .split('\n\n')
    .filter((event) => event.includes('data: '))
    .map((event) => {
      const data = event
        .split('\n')
        .filter((line) => line.startsWith('data: '))
        .map((line) => line.slice(6))
        .join('\n');
      return data === '[DONE]'
        ? null
        : z
            .object({
              error: z.unknown().optional(),
              type: z.string().optional(),
              response: z.object({ error: z.unknown().optional() }).passthrough().optional(),
            })
            .passthrough()
            .parse(JSON.parse(data));
    });
  const errors = events.filter(
    (event) => event && (event.error || event.type === 'response.failed'),
  );
  expect(errors).toHaveLength(1);
  const terminal = errors[0];
  if (!terminal) {
    throw new Error('Expected one terminal error event');
  }
  return protocol === 'responses' ? terminal.response?.error : terminal.error;
}

beforeEach(() => {
  vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
});

describe('Gemini complete-event privacy gate', () => {
  it('retains the upstream rate-limit classification on an unterminated EOF event', async () => {
    const { output, upstream, lease } = await run('gemini', [
      frame(partial),
      frame({
        response: {
          error: {
            code: 429,
            status: 'RESOURCE_EXHAUSTED',
            message: 'Rate limited: token=synthetic-eof-secret',
          },
        },
      }).trimEnd(),
    ]);
    expect(publicError('gemini', output)).toEqual({
      code: 429,
      status: 'RESOURCE_EXHAUSTED',
      message: 'Rate limited: token=[REDACTED]',
    });
    expect(output).toContain('controlled partial');
    expect(output).not.toContain('synthetic-eof-secret');
    expect(output).not.toContain('"finishReason"');
    expect(upstream.streamGenerateInternal).toHaveBeenCalledOnce();
    expect(lease.markModelSuccess).not.toHaveBeenCalled();
  });

  it('does not emit the synthetic EOF flush newline for an empty source', async () => {
    const upstream = createUpstream({ streamFrames: [] });
    const gateway = createGateway(
      upstream,
      createLease([createAccount('empty-stream-controlled')]),
    );
    const stream = await gateway.geminiService.handleGeminiStreamGenerateContent('gemini-3-flash', {
      contents: [{ role: 'user', parts: [{ text: 'controlled' }] }],
    });
    const output: string[] = [];
    await expect(
      new Promise<void>((resolve, reject) => {
        stream.subscribe({ next: (chunk) => output.push(chunk), error: reject, complete: resolve });
      }),
    ).rejects.toThrow('Empty response stream');
    expect(output).toEqual([]);
  });

  it.each(['same-chunk', 'crlf', 'multiline', 'adjacent', 'tail', 'invalid-json'] as const)(
    'does not expose the raw %s error record',
    async (shape) => {
      const error = {
        message: 'Tool read_file failed: token=synthetic-gate-secret',
        details: [{ private: 'synthetic-gate-detail' }],
      };
      const raw =
        shape === 'invalid-json'
          ? 'data: {"error":{"message":"token=synthetic-gate-secret"'
          : shape === 'multiline'
            ? `data: {"error":\ndata: ${JSON.stringify(error)}}\n\n`
            : frame({ error });
      const errorFrame =
        shape === 'tail' ? raw.trimEnd() : shape === 'crlf' ? raw.replaceAll('\n', '\r\n') : raw;
      const prefix = shape === 'adjacent' ? frame(partial).trimEnd() + '\n' : frame(partial);
      const { output, lease } = await run(
        'gemini',
        shape === 'same-chunk' ? [prefix + errorFrame] : [prefix, errorFrame],
      );
      expect(output).toContain('controlled partial');
      expect(output).not.toContain('synthetic-gate-secret');
      expect(output).not.toContain('synthetic-gate-detail');
      expect(publicError('gemini', output)).toEqual({
        code: 502,
        status: 'UPSTREAM_STREAM_ERROR',
        message:
          shape === 'invalid-json'
            ? 'Invalid upstream SSE event.'
            : 'Tool read_file failed: token=[REDACTED]',
      });
      expect(lease.markModelSuccess).not.toHaveBeenCalled();
    },
  );

  it('preserves successful data and ordinary SSE fields/comments', async () => {
    const { output, lease } = await run('gemini', [
      'id: controlled-id\nevent: message\nretry: 1000\n: ping\n' + frame(partial),
      frame(done),
    ]);
    expect(output).toContain('id: controlled-id\nevent: message\nretry: 1000\n: ping\n');
    expect(output).toContain('controlled partial');
    expect(output).toContain('"finishReason":"STOP"');
    expect(lease.markModelSuccess).toHaveBeenCalledOnce();
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  OpenAIResponsesSessionStore.clear();
});

describe.each(['chat', 'responses', 'messages', 'gemini'] as const)(
  '%s public stream error',
  (protocol) => {
    it.each(['bare', 'wrapped', 'fragmented', 'mixed'] as const)(
      'sanitizes one %s error without completing or retrying',
      async (shape) => {
        const error = {
          code: 429,
          status: 'RESOURCE_EXHAUSTED',
          message: 'Tool read_file failed: token=synthetic-stream-secret',
          details: [{ private: 'synthetic-private-detail' }],
        };
        const payload =
          shape === 'wrapped'
            ? { response: { error } }
            : shape === 'mixed'
              ? { ...partial.response, error }
              : { error };
        const encoded = frame(payload);
        const errorChunks = shape === 'fragmented' ? Array.from(encoded) : [encoded];
        const { output, upstream, lease } = await run(protocol, [
          frame(partial),
          ...errorChunks,
          frame(done),
        ]);
        expect(output).toContain('controlled partial');
        expect(output).not.toContain('synthetic-stream-secret');
        expect(output).not.toContain('synthetic-private-detail');
        expect(output).not.toContain('data: [DONE]');
        expect(output).not.toContain('event: response.completed');
        expect(output).not.toContain('event: message_stop');
        expect(output).not.toContain('"finishReason":"STOP"');
        const message = 'Tool read_file failed: token=[REDACTED]';
        expect(publicError(protocol, output)).toEqual(
          protocol === 'gemini'
            ? { code: 429, status: 'RESOURCE_EXHAUSTED', message }
            : protocol === 'messages'
              ? { type: 'rate_limit_error', message }
              : protocol === 'responses'
                ? { code: 'RESOURCE_EXHAUSTED', message }
                : { code: 'RESOURCE_EXHAUSTED', type: 'rate_limit_error', param: null, message },
        );
        if (protocol === 'responses') {
          expect(output).toContain('"input_tokens":7');
          expect(output).toContain('"output_tokens":3');
          expect(output).toContain('"total_tokens":10');
        }
        expect(upstream.streamGenerateInternal).toHaveBeenCalledOnce();
        expect(upstream.generateInternal).not.toHaveBeenCalled();
        expect(lease.markModelSuccess).not.toHaveBeenCalled();
      },
    );

    it('bounds an error message at a Unicode boundary', async () => {
      const { output } = await run(protocol, [
        frame(partial),
        frame({ error: { message: 'a'.repeat(2043) + '😀中文'.repeat(1000) } }),
      ]);
      const message = 'a'.repeat(2043) + '…';
      expect(publicError(protocol, output)).toMatchObject({ message });
      expect(Buffer.byteLength(message, 'utf8')).toBeLessThanOrEqual(2048);
    });

    it('preserves a safe tool name and reason', async () => {
      const message = 'Tool read_file failed: required argument path is missing.';
      const { output } = await run(protocol, [frame(partial), frame({ error: { message } })]);
      expect(publicError(protocol, output)).toMatchObject({ message });
    });

    it('sanitizes a transport exception after output, including the adapter log', async () => {
      const { output, lease } = await run(
        protocol,
        [frame(partial)],
        new Error('token=synthetic-transport-secret'),
      );
      expect(output).toContain('controlled partial');
      expect(output).not.toContain('synthetic-transport-secret');
      expect(publicError(protocol, output)).toBeDefined();
      expect(JSON.stringify(vi.mocked(Logger.prototype.error).mock.calls)).not.toContain(
        'synthetic-transport-secret',
      );
      expect(lease.markModelSuccess).not.toHaveBeenCalled();
    });

    it('preserves an ordinary successful stream', async () => {
      const { output, lease } = await run(protocol, [frame(partial), frame(done)]);
      expect(output).toContain('controlled partial');
      expect(output).not.toContain('"error":');
      expect(lease.markModelSuccess).toHaveBeenCalled();
    });
  },
);

describe.each(['chat', 'messages', 'gemini'] as const)('%s interrupted output', (protocol) => {
  it.each([
    ['text', 'eof'],
    ['text', 'reset'],
    ['tool', 'eof'],
    ['tool', 'reset'],
    ['tool-without-id', 'eof'],
  ] as const)('retains %s and sends one terminal sequence after %s', async (kind, ending) => {
    const text = '```typescript\nconst answer = 42;\n';
    const part =
      kind === 'text'
        ? { text }
        : {
            functionCall: {
              ...(kind === 'tool' ? { id: 'call-interrupted' } : {}),
              name: 'read_file',
              args: { path: '/fixture' },
            },
          };
    const transportError =
      ending === 'reset'
        ? Object.assign(new Error('Controlled connection reset'), { code: 'ECONNRESET' })
        : undefined;
    const { output, upstream, lease } = await run(
      protocol,
      [
        frame({
          response: {
            candidates: [{ content: { role: 'model', parts: [part] } }],
            usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 3, totalTokenCount: 10 },
          },
        }),
      ],
      transportError,
    );
    expect(output).not.toContain('"error":');
    if (kind === 'text') {
      expect(output).toContain(JSON.stringify(text).slice(1, -1));
      expect(output).not.toContain('Warning');
    } else {
      expect(output).toContain('read_file');
      expect(output).toContain('/fixture');
    }
    if (protocol === 'chat') {
      expect(output.match(/"finish_reason":"[^"]+"/gu)).toEqual([
        `"finish_reason":"${kind !== 'text' ? 'tool_calls' : 'length'}"`,
      ]);
      expect(output.match(/data: \[DONE\]/gu)).toHaveLength(1);
    } else if (protocol === 'messages') {
      expect(output.match(/"stop_reason":"[^"]+"/gu)).toEqual([
        `"stop_reason":"${kind !== 'text' ? 'tool_use' : 'max_tokens'}"`,
      ]);
      expect(output.match(/event: message_stop/gu)).toHaveLength(1);
    } else {
      expect(output.match(/"finishReason":"[^"]+"/gu)).toEqual([
        `"finishReason":"${kind !== 'text' ? 'STOP' : 'MAX_TOKENS'}"`,
      ]);
    }
    expect(upstream.streamGenerateInternal).toHaveBeenCalledOnce();
    expect(upstream.generateInternal).not.toHaveBeenCalled();
    expect(lease.markModelSuccess).not.toHaveBeenCalled();
  });

  it.each([
    new UpstreamThoughtSignatureConflictError('controlled fixture'),
    new GenerationDeadlineExceededError(),
    Object.assign(new Error('Upstream request cancelled'), { name: 'AbortError' }),
    new Error('Unknown stream failure'),
  ])('keeps nontransport failure $name explicit after output', async (cause) => {
    const { output, lease } = await run(protocol, [frame(partial)], cause);
    expect(publicError(protocol, output)).toBeDefined();
    expect(output).not.toContain('[DONE]');
    expect(output).not.toContain('event: message_stop');
    expect(output).not.toContain('"finishReason":"MAX_TOKENS"');
    expect(lease.markModelSuccess).not.toHaveBeenCalled();
  });

  it.each([
    { thought: true, text: 'Reasoning without an answer' },
    { text: '   ' },
    { inlineData: { mimeType: 'image/png', data: 'AQ==' } },
  ])('requires visible text or a complete tool before truncation', async (part) => {
    const { output } = await run(protocol, [
      frame({
        response: { candidates: [{ content: { role: 'model', parts: [part] } }] },
      }),
    ]);
    expect(publicError(protocol, output)).toBeDefined();
    expect(output).not.toContain('[DONE]');
    expect(output).not.toContain('event: message_stop');
  });

  it('rejects a malformed trailing frame after valid text', async () => {
    const { output } = await run(protocol, [frame(partial), 'data: {"response":']);
    expect(publicError(protocol, output)).toBeDefined();
    expect(output).not.toContain('[DONE]');
    expect(output).not.toContain('event: message_stop');
  });
});
