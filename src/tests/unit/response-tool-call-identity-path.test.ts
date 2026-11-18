import { Observable } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { SignatureStore } from '@/modules/proxy-gateway/antigravity/SignatureStore';
import type { FunctionCall } from '@/modules/proxy-gateway/antigravity/types';
import { proxyModelAvailabilityStore } from '@/server/gateway/shared/services/model-availability.service';
import {
  collect,
  createAccount,
  createGateway,
  createLease,
  createUpstream,
  geminiStreamFrame,
} from './proxy-real-path.harness';

vi.mock('@/server/gateway/common/utils/request-user-agent', async (original) => ({
  ...(await original<
    typeof import('@/server/gateway/common/utils/request-user-agent')
  >()),
  resolveRequestUserAgent: async () => 'response-tool-identity-fixture',
}));

const call: FunctionCall = { name: 'read', args: { path: '/a' } };
const ChatOutput = z.object({
  choices: z.array(
    z.object({
      message: z.object({ tool_calls: z.array(z.object({ id: z.string() })) }).optional(),
      delta: z.object({ tool_calls: z.array(z.object({ id: z.string() })).optional() }).optional(),
    }),
  ),
});
const ClaudeOutput = z.object({
  content: z.array(z.object({ type: z.string(), id: z.string().optional() }).loose()),
});
const ClaudeStart = z
  .object({
    type: z.literal('content_block_start'),
    content_block: z.object({ type: z.literal('tool_use'), id: z.string() }).loose(),
  })
  .loose();
const ResponseAdded = z
  .object({
    type: z.literal('response.output_item.added'),
    item: z.object({ type: z.literal('function_call'), call_id: z.string() }).loose(),
  })
  .loose();

type Protocol = 'chat' | 'responses' | 'anthropic';
type Mode = 'unary' | 'stream' | 'fallback';

async function run(protocol: Protocol, mode: Mode, prompt: string, calls = [call, call]) {
  const response = {
    candidates: [
      {
        content: { role: 'model', parts: calls.map((functionCall) => ({ functionCall })) },
        finishReason: 'STOP',
      },
    ],
  };
  const upstream = createUpstream({
    generate: response,
    streamFrames: [geminiStreamFrame(response)],
    ...(mode === 'fallback' ? { streamError: new Error('controlled stream setup failure') } : {}),
  });
  const gateway = createGateway(
    upstream,
    createLease([createAccount('response-identity-account')]),
  );
  const result =
    protocol === 'anthropic'
      ? await gateway.anthropicService.handleAnthropicMessages({
          model: 'gemini-3-flash',
          messages: [{ role: 'user', content: prompt }],
          max_tokens: 128,
          stream: mode !== 'unary',
        })
      : await gateway.openAIService.handleChatCompletions(
          {
            model: 'gemini-3-flash',
            messages: [{ role: 'user', content: prompt }],
            stream: mode !== 'unary',
          },
          protocol === 'responses' ? 'responses' : 'chat-completions',
        );
  if (!(result instanceof Observable)) {
    if (protocol === 'anthropic') {
      return ClaudeOutput.parse(result).content.flatMap((block) => (block.id ? [block.id] : []));
    }
    return ChatOutput.parse(result).choices.flatMap(
      (choice) => choice.message?.tool_calls.map((tool) => tool.id) ?? [],
    );
  }
  const sse = await collect(result);
  return sse
    .split('\n')
    .filter((line) => line.startsWith('data: ') && line !== 'data: [DONE]')
    .flatMap((line) => {
      const event: unknown = JSON.parse(line.slice(6));
      if (protocol === 'anthropic') {
        const parsed = ClaudeStart.safeParse(event);
        return parsed.success ? [parsed.data.content_block.id] : [];
      }
      if (protocol === 'responses') {
        const parsed = ResponseAdded.safeParse(event);
        return parsed.success ? [parsed.data.item.call_id] : [];
      }
      const parsed = ChatOutput.safeParse(event);
      return parsed.success
        ? parsed.data.choices.flatMap(
            (choice) => choice.delta?.tool_calls?.map((tool) => tool.id) ?? [],
          )
        : [];
    });
}

afterEach(() => {
  proxyModelAvailabilityStore.clearAccount('response-identity-account');
  SignatureStore.clear();
});

describe.each(['chat', 'responses', 'anthropic'] as const)(
  '%s response identity production path',
  (protocol) => {
    it('keeps replay and streaming/unary IDs stable while distinguishing parallel calls', async () => {
      const baseline = await run(protocol, 'unary', 'Read file A.');
      expect(baseline).toEqual([
        expect.stringMatching(/^call_[a-f0-9]{32}$/),
        expect.stringMatching(/^call_[a-f0-9]{32}$/),
      ]);
      expect(baseline[0]).not.toBe(baseline[1]);
      expect(await run(protocol, 'stream', 'Read file A.')).toEqual(baseline);
      expect(await run(protocol, 'stream', 'Read file A.')).toEqual(baseline);
    });

    it('includes complete request history, rather than only a session or message count', async () => {
      const prefix = 'prefix'.repeat(2000);
      const suffix = 'suffix'.repeat(2000);
      const first = await run(protocol, 'stream', `${prefix}A${suffix}`);
      expect(await run(protocol, 'stream', `${prefix}B${suffix}`)).not.toEqual(first);
    });

    it('preserves upstream IDs in unary and streaming paths', async () => {
      const calls = [{ ...call, id: 'explicit-call' }];
      expect(await run(protocol, 'unary', 'Read file A.', calls)).toEqual(['explicit-call']);
      expect(await run(protocol, 'stream', 'Read file A.', calls)).toEqual(['explicit-call']);
    });
  },
);

it.each(['chat', 'responses'] as const)(
  '%s synthetic fallback preserves response call identity',
  async (protocol) => {
    expect(await run(protocol, 'fallback', 'Read file A.')).toEqual(
      await run(protocol, 'stream', 'Read file A.'),
    );
  },
);
