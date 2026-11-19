import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { DEFAULT_APP_CONFIG } from '@/modules/config/types';
import { setServerConfig } from '@/server/server-config';
import { AnthropicController } from '@/server/gateway/modules/anthropic/anthropic.controller';
import { GeminiController } from '@/server/gateway/modules/gemini/gemini.controller';
import { toInternalGeminiRequest } from '@/server/gateway/modules/gemini/gemini-request-envelope';
import { OpenAIOperations } from '@/server/gateway/modules/openai/openai-operations.service';
import {
  createAccount,
  createGateway,
  createLease,
  createReply,
  createUpstream,
  geminiTextResponse,
} from './proxy-real-path.harness';

vi.mock('@/server/gateway/common/utils/request-user-agent', () => ({
  resolveRequestUserAgent: async () => 'controlled-prompt-boundary/0.0.0',
  buildContentRequestUserAgent: () => 'controlled-prompt-boundary/0.0.0',
  resolveLocalInstalledVersion: () => '0.0.0',
}));

const sdk = "You are a Claude agent, built on Anthropic's Claude Agent SDK.";
const code = "You are Claude Code, Anthropic's official CLI for Claude.";
const codingAssistant = 'You are a coding assistant.';
const sdkInCli =
  "You are Claude Code, Anthropic's official CLI for Claude, running within the Claude Agent SDK.";
const clientPolicy = [
  'IMPORTANT: Assist with authorized security testing, defensive security, CTF challenges, and educational contexts.',
  'Refuse requests for destructive techniques, DoS attacks, mass targeting, supply chain compromise, or detection evasion for malicious purposes.',
  'Dual-use security tools (C2 frameworks, credential testing, exploit development) require clear authorization context: pentesting engagements, CTF competitions, security research, or defensive use cases.',
].join(' ');
const shortPolicy = 'IMPORTANT: Assist with security testing only after approval.';
const billing = 'x-anthropic-billing-header: cc_entrypoint=controlled;';
const user = 'Explain this literal text:\n' + billing + '\n[undefined]\n' + clientPolicy;
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
      [sdk, codingAssistant],
      [sdkInCli, codingAssistant],
      [code, codingAssistant],
      [
        'You are OpenCode, an interactive CLI agent specializing in software engineering tasks.\nKeep the deployment checks.',
        'You are an AI Agent.\nKeep the deployment checks.',
      ],
      [
        'You are a coding agent running in the Codex CLI, a terminal-based coding assistant. ' +
          'Codex CLI is an open source project led by OpenAI. You are expected to be precise, safe, and helpful.\nKeep the deployment checks.',
        'You are a coding assistant. Codex CLI is an open source project led by OpenAI. ' +
          'You are expected to be precise, safe, and helpful.\nKeep the deployment checks.',
      ],
      [sdkInCli + '\nKeep the deployment checks.', sdkInCli + '\nKeep the deployment checks.'],
      [
        'You are Example, an AI assistant created by Example Labs; Keep all source paths relative.',
        'You are an AI Agent; Keep all source paths relative.',
      ],
      [
        'You are Example, an AI assistant created by Example Labs； Keep all source paths relative.',
        'You are an AI Agent； Keep all source paths relative.',
      ],
      [clientPolicy, null],
      [
        '  Keep this.\r\n' +
          clientPolicy.replace('authorized security testing', 'security testing') +
          '\r\n\r\n# Harness\r\nKeep deployment checks.  ',
        '  Keep this.\r\n\r\n# Harness\r\nKeep deployment checks.  ',
      ],
      [
        `\`\`\`text\n${clientPolicy}\n\`\`\`\n<example>\n${clientPolicy}\n</example>\n${shortPolicy}\n# Harness`,
        `\`\`\`text\n${clientPolicy}\n\`\`\`\n<example>\n${clientPolicy}\n</example>\n${shortPolicy}\n# Harness`,
      ],
      ['    ' + clientPolicy, '    ' + clientPolicy],
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
        expect(upstream.calls[0].body.request.systemInstruction).toEqual(
          expected === null ? undefined : { role: 'user', parts: [{ text: expected }] },
        );
        expect(upstream.calls[0].body.request.contents[0].parts).toEqual([{ text: user }]);
        expect(lease.markModelSuccess).toHaveBeenCalledOnce();
      },
    );
  },
);

it('keeps signed, configured, tool and user prompt text outside the client policy cleanup', () => {
  const signed = { text: clientPolicy, thoughtSignature: 'synthetic-signature' };
  const request = {
    contents: [{ role: 'user', parts: [{ text: clientPolicy }] }],
    tools: [{ functionDeclarations: [{ name: 'read_file', description: clientPolicy }] }],
    systemInstruction: { parts: [signed, { text: clientPolicy }] },
  };
  const original = structuredClone(request);
  const outgoing = toInternalGeminiRequest(request, true, clientPolicy);
  expect(outgoing.systemInstruction?.parts).toEqual([
    { text: `<global_system_prompt>\n${clientPolicy}\n</global_system_prompt>` },
    signed,
  ]);
  expect(outgoing.tools).toEqual(original.tools);
  expect(outgoing.contents).toEqual(original.contents);
  expect(request).toEqual(original);
});
