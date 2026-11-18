import { afterEach, describe, expect, it, vi } from 'vitest';
import { createUpstreamSessionIdentity } from '@/server/gateway/common/upstream-session-identity';
import {
  resolveAnthropicSessionScope,
  resolveGeminiSessionScope,
  resolveOpenAISessionScope,
} from '@/server/gateway/common/signature-session-scope';
import { proxyModelAvailabilityStore } from '@/server/gateway/shared/services/model-availability.service';
import {
  collect,
  createAccount,
  createGateway,
  createLease,
  createUpstream,
  geminiTextResponse,
  geminiStreamFrame,
} from './proxy-real-path.harness';

vi.mock('@/server/gateway/common/utils/request-user-agent', async (original) => ({
  ...(await original<object>()),
  resolveRequestUserAgent: async () => 'upstream-identity-test/1.0',
}));
afterEach(() => {
  proxyModelAvailabilityStore.clearAccount('acc-1');
  proxyModelAvailabilityStore.clearAccount('acc-2');
});
const headers = { authorization: 'Bearer synthetic-tenant', 'x-session-id': 'synthetic-session' };
type Surface = 'chat' | 'responses' | 'anthropic' | 'gemini';

describe('protocol upstream identity selection', () => {
  it.each(
    (['chat', 'responses', 'anthropic', 'gemini'] as const).flatMap((surface) =>
      [false, true].map((stream) => ({ surface, stream })),
    ),
  )(
    'carries selected account and anchored store across $surface stream=$stream',
    async ({ surface, stream }) => {
      const upstream = createUpstream({
        generate: geminiTextResponse('ok'),
        streamFrames: [geminiStreamFrame(geminiTextResponse('ok'))],
      });
      const lease = createLease([createAccount('acc-1')]);
      const gateway = createGateway(upstream, lease);
      const body = {
        model: 'gemini-3-flash',
        messages: [{ role: 'user', content: 'Synthetic task' }],
        stream,
      };
      const context = { headers };
      let expectedStore: string | undefined;
      const execute = async (surface: Surface) => {
        if (surface === 'anthropic') {
          expectedStore = resolveAnthropicSessionScope(body, headers).storeKey;
          return gateway.anthropicService.handleAnthropicMessages(body, context);
        }
        if (surface === 'gemini') {
          const request = { contents: [{ role: 'user', parts: [{ text: 'Synthetic task' }] }] };
          expectedStore = resolveGeminiSessionScope(request, headers).storeKey;
          return stream
            ? gateway.geminiService.handleGeminiStreamGenerateContent(
                body.model,
                request,
                undefined,
                context,
              )
            : gateway.geminiService.handleGeminiGenerateContent(
                body.model,
                request,
                'generate-content',
                undefined,
                'gemini',
                context,
              );
        }
        expectedStore = resolveOpenAISessionScope(body, headers).storeKey;
        return gateway.openAIService.handleChatCompletions(
          body,
          surface === 'responses' ? 'responses' : 'chat-completions',
          undefined,
          surface === 'responses'
            ? {
                requestSessionId: 'root',
                routingSessionId: 'synthetic-session',
                responseId: 'next',
              }
            : undefined,
          undefined,
          context,
        );
      };
      const result = await execute(surface);
      if (stream && result && 'subscribe' in result) {
        await collect(result);
      }
      if (!expectedStore) {
        throw new Error('Expected the selected surface to resolve its store');
      }
      expect(upstream.calls.map((call) => call.options?.upstreamSession)).toEqual([
        createUpstreamSessionIdentity('acc-1', expectedStore),
      ]);
      const options = upstream.calls[0].options;
      expect(options?.recoveryAccountId).toBe('acc-1');
      expect(options?.recoveryBudget).toEqual({
        attempted: false,
        deadlineAt: expect.any(Number),
        thinkingOnlyEnabled: false,
      });
      expect(options?.canRecoverUpstreamSession?.()).toBe(true);
      lease.isLeaseEligible.mockReturnValue(false);
      expect(options?.canRecoverUpstreamSession?.()).toBe(false);
    },
  );
});
