import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_APP_CONFIG } from '@/modules/config/types';
import { setServerConfig } from '@/server/server-config';
import {
  createAccount,
  createGateway,
  createLease,
  createUpstream,
  geminiTextResponse,
} from './proxy-real-path.harness';

beforeEach(() => {
  vi.useFakeTimers();
  setServerConfig({ ...DEFAULT_APP_CONFIG.proxy, request_timeout: 120 });
});

afterEach(() => {
  setServerConfig(DEFAULT_APP_CONFIG.proxy);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe.each(['gemini', 'chat', 'responses', 'messages'] as const)(
  '%s generation budget is independent of the transport timeout',
  (surface) => {
    it('delivers a response after the legacy 120-second transport setting', async () => {
      const upstream = createUpstream({});
      upstream.generateInternal.mockImplementation(
        () =>
          new Promise((resolve) =>
            setTimeout(() => resolve(geminiTextResponse('late answer')), 150_000),
          ),
      );
      const lease = createLease([createAccount('generation-budget')]);
      const gateway = createGateway(upstream, lease);
      const request =
        surface === 'gemini'
          ? gateway.geminiService.handleGeminiGenerateContent('gemini-3-flash', {
              contents: [{ role: 'user', parts: [{ text: 'Controlled delayed answer.' }] }],
            })
          : surface === 'messages'
            ? gateway.anthropicService.handleAnthropicMessages({
                model: 'gemini-3-flash',
                max_tokens: 16,
                messages: [{ role: 'user', content: 'Controlled delayed answer.' }],
              })
            : gateway.openAIService.handleChatCompletions(
                {
                  model: 'gemini-3-flash',
                  messages: [{ role: 'user', content: 'Controlled delayed answer.' }],
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
      await vi.advanceTimersByTimeAsync(120_001);
      expect(outcome).toBeUndefined();
      await vi.advanceTimersByTimeAsync(30_000);
      await settled;
      expect(JSON.stringify(outcome)).toContain('late answer');
      expect(upstream.generateInternal).toHaveBeenCalledOnce();
      expect(lease.markFromUpstreamError).not.toHaveBeenCalled();
    });
  },
);
