import { Observable } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { OpenAIOperations } from '@/server/gateway/modules/openai/openai-operations.service';
import { OpenAIResponsesSessionStore } from '@/server/gateway/modules/openai/responses/openai-responses-session.store';
import { decodeAntigravityStreamFrame } from '@/modules/proxy-gateway/antigravity/AntigravityStreamDecoder';
import { GenerationOutputState } from '@/modules/proxy-gateway/antigravity/GenerationOutputState';
import { toOpenAIUsage } from '@/modules/proxy-gateway/antigravity/OpenAIUsageMapper';
import { proxyModelAvailabilityStore } from '@/server/gateway/shared/services/model-availability.service';
import {
  collect,
  createAccount,
  createGateway,
  createLease,
  createReply,
  createUpstream,
  geminiStreamFrame,
} from './proxy-real-path.harness';

vi.mock('@/server/gateway/common/utils/request-user-agent', async (original) => ({
  ...(await original<typeof import('@/server/gateway/common/utils/request-user-agent')>()),
  resolveRequestUserAgent: async () => 'reasoning-usage-test',
}));

const usageMetadata = {
  promptTokenCount: 20,
  candidatesTokenCount: 12,
  totalTokenCount: 32,
  candidatesTokensDetails: [
    { modality: 'THINKING', tokenCount: 4 },
    { modality: 'REASONING', tokenCount: 3 },
    { modality: 'TEXT', tokenCount: 5 },
  ],
};
const response = {
  candidates: [{ content: { parts: [{ text: 'ok' }], role: 'model' }, finishReason: 'STOP' }],
  usageMetadata,
};
const chatUsage = {
  prompt_tokens: 20,
  completion_tokens: 12,
  total_tokens: 32,
  completion_tokens_details: { reasoning_tokens: 7 },
};
const responsesUsage = {
  input_tokens: 20,
  output_tokens: 12,
  total_tokens: 32,
  input_tokens_details: { cached_tokens: 0 },
  output_tokens_details: { reasoning_tokens: 7 },
};

function events(text: string): unknown[] {
  return text
    .split('\n')
    .filter((line) => line.startsWith('data: {'))
    .map((line): unknown => JSON.parse(line.slice(6)));
}

function gateway() {
  return createGateway(
    createUpstream({
      generate: response,
      streamFrames: [geminiStreamFrame(response)],
    }),
    createLease([createAccount('acc-1')]),
  );
}

describe('modality reasoning usage through production protocol paths', () => {
  afterEach(() => {
    proxyModelAvailabilityStore.clearAccount('acc-1');
    OpenAIResponsesSessionStore.clear();
  });

  it('preserves Chat unary counts with supplemental reasoning details', async () => {
    const result = await gateway().openAIService.handleChatCompletions({
      model: 'gemini-3-flash',
      messages: [{ role: 'user', content: 'Usage probe.' }],
      stream: false,
    });
    expect(z.object({ usage: z.unknown() }).parse(result).usage).toEqual(chatUsage);
  });

  it.each([false, true])(
    'preserves Chat streaming placement (include_usage=%s)',
    async (include) => {
      const result = await gateway().openAIService.handleChatCompletions({
        model: 'gemini-3-flash',
        messages: [{ role: 'user', content: 'Usage probe.' }],
        stream: true,
        stream_options: { include_usage: include },
      });
      if (!(result instanceof Observable)) {
        throw new Error('Expected a Chat stream');
      }
      const text = await collect(result);
      const last = z
        .object({ choices: z.array(z.unknown()), usage: z.unknown() })
        .parse(events(text).at(-1));
      expect(last.usage).toEqual(chatUsage);
      expect(last.choices).toHaveLength(include ? 0 : 1);
      expect(text.endsWith('data: [DONE]\n\n')).toBe(true);
    },
  );

  it.each([false, true])('preserves Responses counts (stream=%s)', async (stream) => {
    const reply = createReply();
    await new OpenAIOperations(gateway().openAIService).responses(
      { model: 'gemini-3-flash', input: 'Usage probe.', stream, store: false },
      reply as never,
    );
    if (stream) {
      if (!(reply.body instanceof Observable)) {
        throw new Error('Expected a Responses stream');
      }
      const last = z
        .object({
          type: z.literal('response.completed'),
          response: z.object({ usage: z.unknown() }),
        })
        .parse(events(await collect(reply.body)).at(-1));
      expect(last.response.usage).toEqual({
        input_tokens: 20,
        output_tokens: 12,
        total_tokens: 32,
        output_tokens_details: { reasoning_tokens: 7 },
      });
    } else {
      expect(z.object({ usage: z.unknown() }).parse(reply.body).usage).toEqual(responsesUsage);
    }
  });

  it('narrows malformed modality entries at the upstream Responses boundary', () => {
    const decodeUsage = (usageMetadata: object) => {
      const frame = decodeAntigravityStreamFrame(
        JSON.stringify({ usageMetadata }),
        new GenerationOutputState(),
      );
      if (frame.kind !== 'response') {
        throw new Error(`Expected a response frame, got ${frame.kind}`);
      }
      return frame.usage;
    };
    const normalized = decodeUsage({
      ...usageMetadata,
      candidatesTokensDetails: [
        ...usageMetadata.candidatesTokensDetails,
        null,
        { modality: 'THINKING', tokenCount: '100' },
        { modality: 'REASONING', tokenCount: -100 },
        { modality: 'THINKING', tokenCount: Infinity },
        { tokenCount: 100 },
      ],
    });
    expect(toOpenAIUsage(normalized)).toEqual({
      ...chatUsage,
      prompt_tokens_details: undefined,
    });
    expect(decodeUsage({ candidatesTokensDetails: 'THINKING' })?.reasoningTokens).toBe(0);
  });

  it.each([false, true])(
    'retains Anthropic public usage projection (stream=%s)',
    async (stream) => {
      const result = await gateway().anthropicService.handleAnthropicMessages({
        model: 'gemini-3-flash',
        messages: [{ role: 'user', content: 'Usage probe.' }],
        max_tokens: 256,
        stream,
      });
      if (stream) {
        if (!(result instanceof Observable)) {
          throw new Error('Expected an Anthropic stream');
        }
        const frames = events(await collect(result));
        const final = z
          .object({ type: z.literal('message_delta'), usage: z.unknown() })
          .parse(frames.at(-2));
        expect(final.usage).toEqual({
          input_tokens: 20,
          output_tokens: 12,
          cache_read_input_tokens: 0,
          reasoning_tokens: 7,
        });
      } else {
        expect(z.object({ usage: z.unknown() }).parse(result).usage).toEqual({
          input_tokens: 20,
          output_tokens: 12,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        });
      }
    },
  );
});
