import { Logger } from '@nestjs/common';
import { Observable } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createAccount,
  createGateway,
  createLease,
  createUpstream,
} from './proxy-real-path.harness';
import { aggregationAdmission } from '@/server/gateway/common/aggregation-admission';
import { aggregationByteAccounting } from '@/server/gateway/common/aggregation-byte-accounting';

vi.mock('@/server/gateway/common/utils/request-user-agent', () => ({
  resolveRequestUserAgent: async () => 'controlled-failure-contract/0.0.0',
  buildContentRequestUserAgent: () => 'controlled-failure-contract/0.0.0',
  resolveLocalInstalledVersion: () => '0.0.0',
}));
type Protocol = 'chat' | 'responses' | 'messages' | 'gemini';
function dispatch(gateway: ReturnType<typeof createGateway>, protocol: Protocol, stream = false) {
  if (protocol === 'gemini') {
    const request = { contents: [{ role: 'user', parts: [{ text: 'controlled' }] }] };
    return stream
      ? gateway.geminiService.handleGeminiStreamGenerateContent('gemini-3-flash', request)
      : gateway.geminiService.handleGeminiGenerateContent('gemini-3-flash', request);
  }
  if (protocol === 'messages') {
    return gateway.anthropicService.handleAnthropicMessages({
      model: 'claude-sonnet-4-5',
      max_tokens: 32,
      stream,
      messages: [{ role: 'user', content: 'controlled' }],
    });
  }
  return gateway.openAIService.handleChatCompletions(
    { model: 'gemini-3-flash', stream, messages: [{ role: 'user', content: 'controlled' }] },
    protocol === 'responses' ? 'responses' : 'chat-completions',
  );
}
function response(parts: unknown[], finishReason: unknown = 'STOP') {
  return {
    candidates: [
      {
        content: { role: 'model', parts },
        ...(finishReason === undefined ? {} : { finishReason }),
      },
    ],
  };
}
beforeEach(() => {
  vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  expect(aggregationAdmission.snapshot).toEqual({ active: 0, waiting: 0 });
  expect(aggregationByteAccounting.snapshot.totalBytes).toBe(0);
});

describe.each(['chat', 'responses', 'messages', 'gemini'] as const)(
  '%s generation failure contract',
  (protocol) => {
    it.each([
      [
        'bare',
        {
          error: {
            code: 400,
            status: 'INVALID_ARGUMENT',
            message: 'controlled provider rejection',
          },
        },
      ],
      [
        'wrapped',
        {
          response: {
            error: {
              code: 400,
              status: 'INVALID_ARGUMENT',
              message: 'controlled provider rejection',
            },
          },
        },
      ],
    ])(
      'propagates a %s direct provider error without aggregation fallback',
      async (_shape, payload) => {
        const upstream = createUpstream({ generate: payload });
        const lease = createLease([createAccount('failure-controlled')]);
        await expect(dispatch(createGateway(upstream, lease), protocol)).rejects.toMatchObject({
          status: 400,
          message: 'controlled provider rejection',
        });
        expect(upstream.streamGenerateInternal).not.toHaveBeenCalled();
        expect(lease.markModelSuccess).not.toHaveBeenCalled();
      },
    );

    it.each([
      { error: 'not a structured error' },
      { error: { code: 200, message: 'not an HTTP error' } },
      { candidates: 'invalid container' },
      { candidates: [null] },
      { candidates: [{ content: { parts: 'invalid parts' } }] },
      { candidates: [{ finishReason: 123 }] },
      { unexpected: 'unknown response shape' },
      { usageMetadata: { totalTokenCount: '17' } },
      { usageMetadata: { promptTokenCount: -1 } },
    ])(
      'rejects malformed provider data without retrying another generation: %j',
      async (payload) => {
        const upstream = createUpstream({ generate: payload });
        const lease = createLease([createAccount('failure-controlled')]);
        await expect(dispatch(createGateway(upstream, lease), protocol)).rejects.toMatchObject({
          status: 502,
          code: 'invalid_upstream_response',
        });
        expect(upstream.generateInternal).toHaveBeenCalledOnce();
        expect(upstream.streamGenerateInternal).not.toHaveBeenCalled();
        expect(lease.markModelSuccess).not.toHaveBeenCalled();
      },
    );

    it.each([
      [response([{ text: 'controlled reasoning', thought: true }]), 'empty_thinking_response'],
      [response([{ thoughtSignature: 'synthetic-signature' }]), 'empty_upstream_response'],
      [response([]), 'empty_upstream_response'],
      [response([{ text: '   ' }]), 'empty_upstream_response'],
    ])('reports a typed terminal empty answer without retry: %j', async (payload, code) => {
      const upstream = createUpstream({ generate: payload });
      const lease = createLease([createAccount('failure-controlled')]);
      await expect(dispatch(createGateway(upstream, lease), protocol)).rejects.toMatchObject({
        status: 502,
        code,
      });
      expect(upstream.generateInternal).toHaveBeenCalledOnce();
      expect(upstream.streamGenerateInternal).not.toHaveBeenCalled();
      expect(lease.markModelSuccess).not.toHaveBeenCalled();
    });

    it.each([
      [{ functionCall: { name: 'read_file', args: { path: 'controlled.txt' } } }],
      [{ inlineData: { mimeType: 'image/png', data: 'c3ludGhldGlj' } }],
    ])('preserves non-text output: %j', async (part) => {
      const upstream = createUpstream({ generate: response([part]) });
      const lease = createLease([createAccount('failure-controlled')]);
      await expect(dispatch(createGateway(upstream, lease), protocol)).resolves.toBeDefined();
      expect(lease.markModelSuccess).toHaveBeenCalled();
    });

    it.each([
      response([], 'SAFETY'),
      response([], 'MAX_TOKENS'),
      { promptFeedback: { blockReason: 'SAFETY' } },
    ])('preserves explicit refusal and truncation semantics: %j', async (payload) => {
      const upstream = createUpstream({ generate: payload });
      await expect(
        dispatch(
          createGateway(upstream, createLease([createAccount('failure-controlled')])),
          protocol,
        ),
      ).resolves.toBeDefined();
      expect(upstream.streamGenerateInternal).not.toHaveBeenCalled();
    });

    it.each([
      response([], 'SAFETY'),
      response([], 'MAX_TOKENS'),
      { promptFeedback: { blockReason: 'SAFETY' } },
    ])('preserves a refusal or truncation terminal in a stream: %j', async (payload) => {
      const upstream = createUpstream({ streamFrames: [{ response: payload }] });
      const lease = createLease([createAccount('failure-controlled')]);
      const result = await dispatch(createGateway(upstream, lease), protocol, true);
      if (!(result instanceof Observable)) {
        throw new Error('Expected stream');
      }
      const chunks: string[] = [];
      await new Promise<void>((resolve, reject) =>
        result.subscribe({
          next: (chunk: string) => chunks.push(chunk),
          error: reject,
          complete: resolve,
        }),
      );
      const output = chunks.join('');
      expect(output).not.toContain('"error":');
      expect(output).not.toContain('"text":"."');
      expect(output).not.toContain('event: response.failed');
      expect(upstream.streamGenerateInternal).toHaveBeenCalledOnce();
      expect(upstream.generateInternal).not.toHaveBeenCalled();
      expect(lease.markModelSuccess).toHaveBeenCalledOnce();
    });

    it.each([
      response([{ text: 'reasoning without answer', thought: true }]),
      response([{ thoughtSignature: 'synthetic-signature' }]),
      response([]),
      { response: { error: 'malformed error' } },
    ])('cannot mark an unusable stream successful: %j', async (payload) => {
      const upstream = createUpstream({
        streamFrames: [
          {
            response: {
              candidates: [
                { content: { role: 'model', parts: [{ text: 'reasoning', thought: true }] } },
              ],
            },
          },
          { response: payload },
        ],
      });
      const lease = createLease([createAccount('failure-controlled')]);
      const result = await dispatch(createGateway(upstream, lease), protocol, true);
      expect(result).toBeInstanceOf(Observable);
      if (!(result instanceof Observable)) {
        throw new Error('Expected stream');
      }
      const chunks: string[] = [];
      await new Promise<void>((resolve, reject) =>
        result.subscribe({
          next: (chunk: string) => chunks.push(chunk),
          error: reject,
          complete: resolve,
        }),
      );
      const output = chunks.join('');
      expect(output).toContain('"error":');
      expect(output).not.toContain('data: [DONE]');
      expect(output).not.toContain('event: response.completed');
      expect(output).not.toContain('event: message_stop');
      expect(output).not.toContain('"finishReason":"STOP"');
      expect(lease.markModelSuccess).not.toHaveBeenCalled();
      expect(upstream.streamGenerateInternal).toHaveBeenCalledOnce();
      expect(upstream.generateInternal).not.toHaveBeenCalled();
    });
  },
);
