import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { transformResponse } from '@/modules/proxy-gateway/antigravity/ClaudeResponseMapper';
import {
  PartProcessor,
  StreamingState,
} from '@/modules/proxy-gateway/antigravity/ClaudeStreamingMapper';
import { OpenAIResponsesStreamingMapper } from '@/server/gateway/modules/openai/responses/OpenAIResponsesStreamingMapper';
import { SignatureStore } from '@/modules/proxy-gateway/antigravity/SignatureStore';
import type { FunctionCall } from '@/modules/proxy-gateway/antigravity/types';
import { ResponseToolCallIdentity } from '@/modules/proxy-gateway/antigravity/ResponseToolCallIdentity';

const call: FunctionCall = { name: 'read', args: { path: '/a', options: { lines: 2 } } };
const signature = 'opaque-response-tool-signature';
const context = { model: 'gemini-pro', sessionKey: 'response-identity', messageCount: 2 };
const ToolStart = z
  .object({
    type: z.literal('content_block_start'),
    content_block: z.object({ type: z.literal('tool_use'), id: z.string() }).loose(),
  })
  .loose();
const ResponseToolAdded = z
  .object({
    type: z.literal('response.output_item.added'),
    item: z.object({ type: z.literal('function_call'), call_id: z.string() }).loose(),
  })
  .loose();

function data(chunks: string[]) {
  return chunks.flatMap((chunk) =>
    chunk
      .split('\n')
      .filter((line) => line.startsWith('data: '))
      .map((line) => JSON.parse(line.slice(6))),
  );
}

function unary(calls: FunctionCall[]) {
  return transformResponse(
    {
      responseId: 'upstream-response',
      modelVersion: context.model,
      candidates: [
        {
          content: {
            role: 'model',
            parts: calls.map((functionCall) => ({
              functionCall,
              thoughtSignature: signature,
            })),
          },
        },
      ],
    },
    { model: context.model, signatureSessionKey: context.sessionKey, signatureMessageCount: 2 },
  ).content.flatMap((block) => (block.type === 'tool_use' ? [block.id] : []));
}

function claudeStream(calls: FunctionCall[]) {
  const processor = new PartProcessor(new StreamingState(context));
  return data(
    calls.flatMap((functionCall) =>
      processor.process({ functionCall, thoughtSignature: signature }),
    ),
  ).flatMap((event) => {
    const parsed = ToolStart.safeParse(event);
    return parsed.success ? [parsed.data.content_block.id] : [];
  });
}

function responses(calls: FunctionCall[]) {
  const mapper = new OpenAIResponsesStreamingMapper({
    model: context.model,
    responseId: 'resp_test',
    signatureSourceModel: context.model,
    signatureSessionKey: context.sessionKey,
    signatureMessageCount: 2,
  });
  return data(
    calls.flatMap((functionCall) => [
      ...mapper.processPart({
        toolCall: { name: functionCall.name, id: functionCall.id, arguments: functionCall.args },
        signature,
      }),
    ]),
  ).flatMap((event) => {
    const parsed = ResponseToolAdded.safeParse(event);
    return parsed.success ? [parsed.data.item.call_id] : [];
  });
}

afterEach(() => SignatureStore.clear());

describe.each([
  ['Claude unary', unary],
  ['Claude stream', claudeStream],
  ['Responses stream', responses],
] as const)('%s missing response tool IDs', (_name, map) => {
  it('replays stably and distinguishes identical parallel calls', () => {
    const first = map([call, call]);
    expect(first).toHaveLength(2);
    expect(first[0]).not.toBe(first[1]);
    expect(map([structuredClone(call), structuredClone(call)])).toEqual(first);
  });

  it('includes canonical arguments and the tool name in missing identity', () => {
    const original = map([call]);
    expect(map([{ ...call, args: { options: { lines: 2 }, path: '/a' } }])).toEqual(original);
    expect(map([{ ...call, args: { path: '/b', options: { lines: 2 } } }])).not.toEqual(original);
    expect(map([{ ...call, name: 'write' }])).not.toEqual(original);
  });

  it('preserves explicit IDs and associates signatures with the emitted ID', () => {
    const input = [{ ...call, id: 'provided-call' }, call];
    const before = structuredClone(input);
    const ids = map(input);
    expect(ids[0]).toBe('provided-call');
    expect(input).toEqual(before);
    for (const toolCallId of ids) {
      expect(SignatureStore.getForToolCall({ ...context, toolCallId, toolName: call.name })).toBe(
        signature,
      );
    }
  });
});

describe('response request anchor ownership', () => {
  it('hashes a request lazily once and bypasses it for supplied IDs', () => {
    const readAnchor = vi.fn(() => 'full-request-anchor');
    const identity = new ResponseToolCallIdentity(readAnchor);
    expect(identity.resolve('read', {}, 0, 'explicit-id')).toBe('explicit-id');
    expect(readAnchor).not.toHaveBeenCalled();
    const first = identity.resolve('read', { path: '/a' }, 1);
    expect(identity.resolve('read', { path: '/a' }, 1)).toBe(first);
    expect(identity.resolve('read', { path: '/a' }, 2)).not.toBe(first);
    expect(readAnchor).toHaveBeenCalledTimes(1);
  });

  it('keeps identities within their causal request scope', () => {
    const first = new ResponseToolCallIdentity(() => 'request-a');
    const second = new ResponseToolCallIdentity(() => 'request-b');
    expect(first.resolve(call.name, call.args, 0)).not.toBe(
      second.resolve(call.name, call.args, 0),
    );
  });
});
