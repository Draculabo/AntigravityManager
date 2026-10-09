import { afterEach, describe, expect, it, vi } from 'vitest';
import { SignatureStore } from '@/modules/proxy-gateway/antigravity/SignatureStore';
import type {
  AnthropicChatRequest,
  OpenAIChatRequest,
} from '@/modules/proxy-gateway/server/common/interfaces/request-interfaces';
import {
  collect,
  createAccount,
  createGateway,
  createLease,
  createUpstream,
  geminiStreamFrame,
} from './proxy-real-path.harness';
import { Observable } from 'rxjs';

vi.mock('@/modules/proxy-gateway/server/common/utils/request-user-agent', async (original) => ({
  ...(await original<object>()),
  resolveRequestUserAgent: async () => 'signature-test/1.0',
}));

const signatureA = 'synthetic-signature-task-a'.repeat(4);
const signatureB = 'synthetic-signature-task-b'.repeat(4);
const response = (signature: string) => ({
  candidates: [
    {
      content: {
        role: 'model',
        parts: [
          {
            functionCall: { id: 'call_reused', name: 'read', args: {} },
            thoughtSignature: signature,
          },
        ],
      },
      finishReason: 'STOP',
    },
  ],
});

describe('real gateway signature isolation', () => {
  afterEach(() => SignatureStore.clear());

  it.each([false, true])('isolates anonymous OpenAI tool loops, stream=%s', async (stream) => {
    const upstream = createUpstream({
      generate: response(signatureA),
      streamFrames: [geminiStreamFrame(response(signatureA))],
    });
    const { openAIService } = createGateway(upstream, createLease([createAccount('acc-1')]));
    const a: OpenAIChatRequest = {
      model: 'gemini-pro-agent',
      stream,
      messages: [{ role: 'user', content: 'Read task A' }],
      tools: [{ type: 'function', function: { name: 'read', parameters: { type: 'object' } } }],
    };
    const b: OpenAIChatRequest = {
      ...a,
      messages: [
        { role: 'user', content: 'Read task B' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            { id: 'call_reused', type: 'function', function: { name: 'read', arguments: '{}' } },
          ],
        },
        { role: 'tool', tool_call_id: 'call_reused', content: 'B fixture' },
      ],
    };
    const first = await openAIService.handleChatCompletions(a);
    if (first instanceof Observable) {
      await collect(first);
    }
    const second = await openAIService.handleChatCompletions(b);
    if (second instanceof Observable) {
      await collect(second);
    }
    expect(JSON.stringify(upstream.calls[1]?.body)).not.toContain(signatureA);
    const continuation: OpenAIChatRequest = {
      ...b,
      messages: [{ role: 'user', content: 'Read task A' }, ...b.messages.slice(1)],
    };
    const third = await openAIService.handleChatCompletions(continuation);
    if (third instanceof Observable) {
      await collect(third);
    }
    expect(
      upstream.calls[2]?.body.request.contents
        .flatMap((item) => item.parts)
        .filter((part) => part.functionCall)
        .map((part) => part.thoughtSignature),
    ).toEqual([signatureA]);
  });

  it.each([false, true])(
    'keeps interleaved Anthropic calls in their own scopes, stream=%s',
    async (stream) => {
      let count = 0;
      const upstream = createUpstream({
        generate: () => response(++count === 1 ? signatureA : signatureB),
        streamFrames: [geminiStreamFrame(response(signatureA))],
      });
      const { anthropicService } = createGateway(upstream, createLease([createAccount('acc-1')]));
      const a: AnthropicChatRequest = {
        model: 'gemini-pro-agent',
        max_tokens: 128,
        stream,
        messages: [{ role: 'user', content: 'Read task A' }],
        tools: [{ name: 'read', input_schema: { type: 'object' } }],
      };
      const b: AnthropicChatRequest = {
        ...a,
        messages: [{ role: 'user', content: 'Read task B' }],
      };
      for (const [index, request] of [a, b].entries()) {
        upstream.streamGenerateInternal.mockImplementationOnce(async (body, accessToken) => {
          const { Readable } = await import('node:stream');
          upstream.calls.push({ body, accessToken, kind: 'stream' });
          return Readable.from([
            Buffer.from(
              `data: ${JSON.stringify(geminiStreamFrame(response(index === 0 ? signatureA : signatureB)))}\n\n`,
            ),
          ]);
        });
        const result = await anthropicService.handleAnthropicMessages(request);
        if (result instanceof Observable) {
          await collect(result);
        }
      }
      const result = await anthropicService.handleAnthropicMessages({
        ...a,
        messages: [
          ...a.messages,
          {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'call_reused', name: 'read', input: {} }],
          },
          {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'call_reused', content: 'A fixture' }],
          },
        ],
      });
      if (result instanceof Observable) {
        await collect(result);
      }
      expect(
        upstream.calls[2]?.body.request.contents
          .flatMap((item) => item.parts)
          .filter((part) => part.functionCall)
          .map((part) => part.thoughtSignature),
      ).toEqual([signatureA]);
      expect(JSON.stringify(upstream.calls[2]?.body)).not.toContain(signatureB);
    },
  );
});
