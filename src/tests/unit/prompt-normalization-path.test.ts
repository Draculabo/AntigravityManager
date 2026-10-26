import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { DEFAULT_APP_CONFIG } from '@/modules/config/types';
import { setServerConfig } from '@/server/server-config';
import { AnthropicController } from '@/modules/proxy-gateway/server/modules/anthropic/anthropic.controller';
import { GeminiController } from '@/modules/proxy-gateway/server/modules/gemini/gemini.controller';
import { OpenAIOperations } from '@/modules/proxy-gateway/server/modules/openai/openai-operations.service';
import {
  createAccount,
  createGateway,
  createLease,
  createReply,
  createUpstream,
  geminiTextResponse,
} from './proxy-real-path.harness';

vi.mock('@/modules/proxy-gateway/server/common/utils/request-user-agent', () => ({
  resolveRequestUserAgent: async () => 'controlled-prompt-boundary/0.0.0',
  buildContentRequestUserAgent: () => 'controlled-prompt-boundary/0.0.0',
  resolveLocalInstalledVersion: () => '0.0.0',
}));

const sdk = "You are a Claude agent, built on Anthropic's Claude Agent SDK.";
const billing = 'x-anthropic-billing-header: cc_entrypoint=controlled;';
const user = 'Explain this literal line:\n' + billing + '\n[undefined]';
beforeEach(() => {
  setServerConfig(DEFAULT_APP_CONFIG.proxy);
  vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  setServerConfig(DEFAULT_APP_CONFIG.proxy);
});

describe.each(['chat', 'responses', 'messages', 'gemini'] as const)(
  '%s prompt normalization execution',
  (protocol) => {
    it.each([
      [sdk, "You are Claude Code, Anthropic's official CLI for Claude."],
      [
        'You are Example, an AI assistant created by Example Labs.\r\nKeep this.  ',
        'You are an AI Agent.\r\nKeep this.  ',
      ],
      [
        `<example>\n${billing}\n${sdk}\n</example>\n${billing}\nKeep date 2026-10-31.`,
        `<example>\n${billing}\n${sdk}\n</example>\nKeep date 2026-10-31.`,
      ],
    ])(
      'normalizes the outbound system once and preserves ordinary input: %j',
      async (input, expected) => {
        const upstream = createUpstream({ generate: geminiTextResponse('controlled answer') });
        const lease = createLease([createAccount('prompt-boundary-controlled')]);
        const gateway = createGateway(upstream, lease);
        const reply = createReply();
        if (protocol === 'gemini') {
          const request = {
            contents: [{ role: 'user', parts: [{ text: user }] }],
            systemInstruction: { parts: [{ text: input }] },
          };
          const before = structuredClone(request);
          await new GeminiController(gateway.geminiService).modelAction(
            'gemini-3-flash:generateContent',
            request,
            reply as never,
          );
          expect(request).toEqual(before);
        } else if (protocol === 'messages') {
          const request = {
            model: 'claude-sonnet-4-5',
            max_tokens: 32,
            system: input,
            messages: [{ role: 'user', content: user }],
          };
          const before = structuredClone(request);
          await new AnthropicController(gateway.anthropicService).anthropicMessages(
            request,
            reply as never,
          );
          expect(request).toEqual(before);
        } else {
          const operations = new OpenAIOperations(gateway.openAIService);
          if (protocol === 'responses') {
            await operations.responses(
              { model: 'gemini-3-flash', instructions: input, input: user },
              reply as never,
            );
          } else {
            await operations.chatCompletions(
              {
                model: 'gemini-3-flash',
                messages: [
                  { role: 'system', content: input },
                  { role: 'user', content: user },
                ],
              },
              reply as never,
            );
          }
        }
        expect(reply.statusCode).toBe(200);
        expect(upstream.calls).toHaveLength(1);
        expect(upstream.calls[0].body.request.systemInstruction).toEqual({
          role: 'user',
          parts: [{ text: expected }],
        });
        expect(upstream.calls[0].body.request.contents[0].parts).toEqual([{ text: user }]);
        expect(lease.markModelSuccess).toHaveBeenCalledOnce();
      },
    );
  },
);
