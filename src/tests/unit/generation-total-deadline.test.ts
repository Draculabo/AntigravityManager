import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import { Observable } from 'rxjs';
import { FlowControlledSseStream } from '@/server/gateway/common/flow-controlled-sse-stream';
import { setServerConfig } from '@/server/server-config';
import { DEFAULT_APP_CONFIG } from '@/modules/config/types';
import {
  createAccount,
  createGateway,
  createLease,
  createUpstream,
  geminiTextResponse,
} from './proxy-real-path.harness';

beforeEach(() => {
  vi.useFakeTimers();
  setServerConfig({ ...DEFAULT_APP_CONFIG.proxy, generation_timeout: 1 });
});
afterEach(() => {
  setServerConfig(DEFAULT_APP_CONFIG.proxy);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe.each(['gemini', 'chat', 'responses', 'messages'] as const)(
  '%s logical generation deadline',
  (surface) => {
    it('ends an established paused stream at the same business deadline', async () => {
      const source = new PassThrough();
      source.write(
        'data: {"response":{"candidates":[{"content":{"role":"model","parts":[{"text":"started"}]}}]}}\n\n',
      );
      const upstream = createUpstream({});
      upstream.streamGenerateInternal.mockResolvedValue(source);
      const lease = createLease([createAccount('deadline-stream')]);
      const gateway = createGateway(upstream, lease);
      const result =
        surface === 'gemini'
          ? await gateway.geminiService.handleGeminiStreamGenerateContent('gemini-3-flash', {
              contents: [{ role: 'user', parts: [{ text: 'Controlled streaming deadline.' }] }],
            })
          : surface === 'messages'
            ? await gateway.anthropicService.handleAnthropicMessages({
                model: 'gemini-3-flash',
                max_tokens: 16,
                stream: true,
                messages: [{ role: 'user', content: 'Controlled streaming deadline.' }],
              })
            : await gateway.openAIService.handleChatCompletions(
                {
                  model: 'gemini-3-flash',
                  stream: true,
                  messages: [{ role: 'user', content: 'Controlled streaming deadline.' }],
                },
                surface === 'responses' ? 'responses' : 'chat-completions',
              );
      if (!(result instanceof Observable)) {
        throw new Error('Expected protocol stream');
      }
      const errors: unknown[] = [];
      result.subscribe({ error: (error: unknown) => errors.push(error) });
      expect(result).toBeInstanceOf(FlowControlledSseStream);
      if (result instanceof FlowControlledSseStream) {
        result.pause();
      }
      await vi.advanceTimersByTimeAsync(1001);
      expect(errors).toMatchObject([
        { name: 'GenerationDeadlineExceededError', code: 'ETIMEDOUT' },
      ]);
      expect(source.destroyed).toBe(true);
      expect(lease.markFromUpstreamError).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    });

    it('ends a stalled account-selection waiter and excludes its late success', async () => {
      const upstream = createUpstream({ generate: geminiTextResponse('late output') });
      const account = createAccount('deadline-a');
      const lease = createLease([account]);
      let release: (value: typeof account) => void = () => undefined;
      lease.getNextToken.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      );
      const gateway = createGateway(upstream, lease);
      const request =
        surface === 'gemini'
          ? gateway.geminiService.handleGeminiGenerateContent('gemini-3-flash', {
              contents: [{ role: 'user', parts: [{ text: 'Controlled deadline request.' }] }],
            })
          : surface === 'messages'
            ? gateway.anthropicService.handleAnthropicMessages({
                model: 'gemini-3-flash',
                max_tokens: 16,
                messages: [{ role: 'user', content: 'Controlled deadline request.' }],
              })
            : gateway.openAIService.handleChatCompletions(
                {
                  model: 'gemini-3-flash',
                  messages: [{ role: 'user', content: 'Controlled deadline request.' }],
                },
                surface === 'responses' ? 'responses' : 'chat-completions',
              );
      let outcome: unknown;
      const settled = request.then(
        (value) => {
          outcome = value;
        },
        (error: unknown) => {
          outcome = error;
        },
      );
      try {
        await vi.advanceTimersByTimeAsync(1001);
        expect(outcome).toMatchObject({
          name: 'GenerationDeadlineExceededError',
          code: 'ETIMEDOUT',
        });
      } finally {
        release(account);
        await settled;
      }
      expect(upstream.generateInternal).not.toHaveBeenCalled();
      expect(lease.commitSession).not.toHaveBeenCalled();
      expect(lease.markModelSuccess).not.toHaveBeenCalled();
      expect(lease.markFromUpstreamError).not.toHaveBeenCalled();
    });
  },
);
