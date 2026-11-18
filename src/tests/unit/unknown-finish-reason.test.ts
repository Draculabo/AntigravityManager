import { Observable } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenAIOperations } from '@/server/gateway/modules/openai/openai-operations.service';
import { OpenAIResponsesSessionStore } from '@/server/gateway/modules/openai/responses/openai-responses-session.store';
import { AnthropicController } from '@/server/gateway/modules/anthropic/anthropic.controller';
import { GeminiController } from '@/server/gateway/modules/gemini/gemini.controller';
import { aggregationAdmission } from '@/server/gateway/common/aggregation-admission';
import { aggregationByteAccounting } from '@/server/gateway/common/aggregation-byte-accounting';
import {
  createAccount,
  createGateway,
  createLease,
  createReply,
  createUpstream,
} from './proxy-real-path.harness';

vi.mock(
  '@/server/gateway/common/utils/request-user-agent',
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import('@/server/gateway/common/utils/request-user-agent')
    >()),
    resolveRequestUserAgent: async () => 'controlled-terminal-test/0.0.0',
  }),
);

type Protocol = 'chat' | 'responses' | 'messages' | 'gemini';

function response(finishReason?: string) {
  return {
    candidates: [
      {
        content: { role: 'model', parts: [{ text: 'controlled partial' }] },
        ...(finishReason === undefined ? {} : { finishReason }),
      },
    ],
    usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 3, totalTokenCount: 10 },
  };
}

function dispatch(gateway: ReturnType<typeof createGateway>, protocol: Protocol, stream: boolean) {
  if (protocol === 'gemini') {
    const request = { contents: [{ role: 'user', parts: [{ text: 'controlled input' }] }] };
    return stream
      ? gateway.geminiService.handleGeminiStreamGenerateContent('gemini-3-flash', request)
      : gateway.geminiService.handleGeminiGenerateContent('gemini-3-flash', request);
  }
  if (protocol === 'messages') {
    return gateway.anthropicService.handleAnthropicMessages({
      model: 'claude-sonnet-4-5',
      max_tokens: 32,
      stream,
      messages: [{ role: 'user', content: 'controlled input' }],
    });
  }
  return gateway.openAIService.handleChatCompletions(
    {
      model: 'gemini-3-flash',
      stream,
      ...(stream ? { stream_options: { include_usage: true } } : {}),
      messages: [{ role: 'user', content: 'controlled input' }],
    },
    protocol === 'responses' ? 'responses' : 'chat-completions',
  );
}

afterEach(() => {
  OpenAIResponsesSessionStore.clear();
  expect(aggregationAdmission.snapshot).toEqual({ active: 0, waiting: 0 });
  expect(aggregationByteAccounting.snapshot.totalBytes).toBe(0);
});

async function collect(stream: Observable<string>): Promise<string[]> {
  const chunks: string[] = [];
  await new Promise<void>((resolve, reject) => {
    stream.subscribe({ next: (chunk) => chunks.push(chunk), error: reject, complete: resolve });
  });
  return chunks;
}

describe.each(['chat', 'responses', 'messages', 'gemini'] as const)(
  '%s unknown upstream finish reason',
  (protocol) => {
    it('fails a direct response without account rotation or stream fallback', async () => {
      const upstream = createUpstream({ generate: response('FUTURE_TERMINAL_STATE') });
      const lease = createLease([createAccount('finish-a'), createAccount('finish-b')]);
      const gateway = createGateway(upstream, lease);
      await expect(dispatch(gateway, protocol, false)).rejects.toMatchObject({
        message: 'Upstream returned an unsupported finish reason.',
        status: 502,
      });
      expect(upstream.generateInternal).toHaveBeenCalledOnce();
      expect(upstream.streamGenerateInternal).not.toHaveBeenCalled();
      expect(lease.markModelSuccess).not.toHaveBeenCalled();
    });

    it('fails stream aggregation instead of accepting a later STOP', async () => {
      const upstream = createUpstream({
        generate: { candidates: [{ content: { role: 'model', parts: [] } }] },
        streamFrames: [
          { response: response('FUTURE_TERMINAL_STATE') },
          { response: response('STOP') },
        ],
      });
      const lease = createLease([createAccount('finish-a'), createAccount('finish-b')]);
      await expect(dispatch(createGateway(upstream, lease), protocol, false)).rejects.toMatchObject(
        {
          message: 'Upstream returned an unsupported finish reason.',
          status: 502,
        },
      );
      expect(upstream.generateInternal).toHaveBeenCalledOnce();
      expect(upstream.streamGenerateInternal).toHaveBeenCalledOnce();
      expect(lease.markModelSuccess).not.toHaveBeenCalled();
    });

    it('does not let a supported primary candidate hide an unknown secondary reason', async () => {
      const direct = response('STOP');
      direct.candidates.push(...response('FUTURE_TERMINAL_STATE').candidates);
      const upstream = createUpstream({ generate: direct });
      const lease = createLease([createAccount('finish-multi')]);
      await expect(dispatch(createGateway(upstream, lease), protocol, false)).rejects.toMatchObject(
        {
          message: 'Upstream returned an unsupported finish reason.',
          status: 502,
          finishReason: 'FUTURE_TERMINAL_STATE',
        },
      );
      expect(upstream.generateInternal).toHaveBeenCalledOnce();
      expect(upstream.streamGenerateInternal).not.toHaveBeenCalled();
      expect(lease.markModelSuccess).not.toHaveBeenCalled();
    });

    it('ends delivered partial output with one failure and no normal terminal', async () => {
      const upstream = createUpstream({
        streamFrames: [
          { response: response() },
          { response: response('FUTURE_TERMINAL_STATE') },
          { response: response('STOP') },
        ],
      });
      const lease = createLease([createAccount('finish-a'), createAccount('finish-b')]);
      const stream = await dispatch(createGateway(upstream, lease), protocol, true);
      if (!(stream instanceof Observable)) {
        throw new Error('Expected production stream');
      }
      const chunks = await collect(stream);
      const output = chunks.join('');
      expect(output).toContain('controlled partial');
      expect(output.split('Upstream returned an unsupported finish reason.')).toHaveLength(2);
      expect(output).not.toContain('data: [DONE]');
      expect(output).not.toContain('event: response.completed');
      expect(output).not.toContain('event: message_stop');
      expect(output).not.toContain('"finishReason":"STOP"');
      if (protocol === 'chat') {
        expect(output).not.toContain('"choices":[]');
      }
      expect(upstream.streamGenerateInternal).toHaveBeenCalledOnce();
      expect(upstream.generateInternal).not.toHaveBeenCalled();
      expect(lease.markModelSuccess).not.toHaveBeenCalled();
    });

    it('returns a protocol HTTP 502 without exposing the unknown terminal value', async () => {
      const upstream = createUpstream({ generate: response('FUTURE_TERMINAL_STATE') });
      const lease = createLease([createAccount('finish-http')]);
      const gateway = createGateway(upstream, lease);
      const reply = createReply();
      if (protocol === 'gemini') {
        await new GeminiController(gateway.geminiService).modelAction(
          'gemini-3-flash:generateContent',
          { contents: [{ role: 'user', parts: [{ text: 'controlled input' }] }] },
          reply as never,
        );
      } else if (protocol === 'messages') {
        await new AnthropicController(gateway.anthropicService).anthropicMessages(
          {
            model: 'claude-sonnet-4-5',
            max_tokens: 32,
            messages: [{ role: 'user', content: 'controlled input' }],
          },
          reply as never,
        );
      } else if (protocol === 'responses') {
        await new OpenAIOperations(gateway.openAIService).responses(
          {
            model: 'gemini-3-flash',
            input: 'controlled input',
          },
          reply as never,
        );
      } else {
        await new OpenAIOperations(gateway.openAIService).chatCompletions(
          {
            model: 'gemini-3-flash',
            messages: [{ role: 'user', content: 'controlled input' }],
          },
          reply as never,
        );
      }
      expect(reply.statusCode).toBe(502);
      const message = 'Upstream returned an unsupported finish reason.';
      expect(reply.body).toEqual(
        protocol === 'gemini'
          ? { error: { code: 502, message, status: 'INTERNAL' } }
          : protocol === 'messages'
            ? { type: 'error', error: { type: 'api_error', message } }
            : { error: { type: 'server_error', message } },
      );
      expect(upstream.generateInternal).toHaveBeenCalledOnce();
      expect(upstream.streamGenerateInternal).not.toHaveBeenCalled();
      expect(lease.markModelSuccess).not.toHaveBeenCalled();
    });

    it.each(['MAX_TOKENS', 'SAFETY', 'RECITATION', 'MALFORMED_FUNCTION_CALL'])(
      'preserves the supported %s terminal state',
      async (finishReason) => {
        const upstream = createUpstream({ generate: response(finishReason) });
        const lease = createLease([createAccount('finish-known')]);
        await expect(
          dispatch(createGateway(upstream, lease), protocol, false),
        ).resolves.toBeDefined();
        expect(upstream.generateInternal).toHaveBeenCalledOnce();
        expect(upstream.streamGenerateInternal).not.toHaveBeenCalled();
        expect(lease.markModelSuccess).toHaveBeenCalledOnce();
      },
    );

    it('retains a supported STOP response as a valid neighboring case', async () => {
      const upstream = createUpstream({ generate: response('STOP') });
      const lease = createLease([createAccount('finish-a')]);
      await expect(
        dispatch(createGateway(upstream, lease), protocol, false),
      ).resolves.toBeDefined();
      expect(upstream.generateInternal).toHaveBeenCalledOnce();
      expect(lease.markModelSuccess).toHaveBeenCalledOnce();
    });
  },
);

it('rejects an unsupported first Anthropic event without a downgrade or another account', async () => {
  const upstream = createUpstream({
    streamFrames: [{ response: response('FUTURE_TERMINAL_STATE') }],
  });
  const lease = createLease([createAccount('finish-first-a'), createAccount('finish-first-b')]);
  await expect(dispatch(createGateway(upstream, lease), 'messages', true)).rejects.toMatchObject({
    message: 'Upstream returned an unsupported finish reason.',
    status: 502,
    finishReason: 'FUTURE_TERMINAL_STATE',
    finishReasonTruncated: false,
  });
  expect(upstream.generateInternal).not.toHaveBeenCalled();
  expect(upstream.streamGenerateInternal).toHaveBeenCalledOnce();
  expect(lease.markModelSuccess).not.toHaveBeenCalled();
});

it('does not persist a failed Responses stream or fabricate successful usage', async () => {
  const upstream = createUpstream({
    streamFrames: [{ response: response() }, { response: response('FUTURE_TERMINAL_STATE') }],
  });
  const lease = createLease([createAccount('finish-cache')]);
  const reply = createReply();
  let sent: unknown;
  reply.send = vi.fn((value: unknown) => {
    sent = value;
    return reply;
  });
  await new OpenAIOperations(createGateway(upstream, lease).openAIService).responses(
    {
      model: 'gemini-3-flash',
      stream: true,
      input: 'controlled input',
    },
    reply as never,
  );
  if (!(sent instanceof Observable)) {
    throw new Error('Expected cached Responses stream');
  }
  const chunks = await collect(sent);
  const output = chunks.join('');
  expect(output.split('event: response.failed')).toHaveLength(2);
  expect(output).not.toContain('event: response.completed');
  expect(output).toContain('"input_tokens":7');
  expect(output).toContain('"output_tokens":3');
  expect(output).toContain('"total_tokens":10');
  const id = /"id":"(resp_[^"]+)"/u.exec(output)?.[1];
  expect(id).toBeDefined();
  if (id) {
    expect(OpenAIResponsesSessionStore.get(id)).toBeNull();
  }
  expect(lease.markModelSuccess).not.toHaveBeenCalled();
});
