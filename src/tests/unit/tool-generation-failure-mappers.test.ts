import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { transformResponse } from '@/modules/proxy-gateway/antigravity/ClaudeResponseMapper';
import { decodeAntigravityGenerationResult } from '@/modules/proxy-gateway/antigravity/AntigravityResponseDecoder';
import { decodeAntigravityStreamFrame } from '@/modules/proxy-gateway/antigravity/AntigravityStreamDecoder';
import {
  PartProcessor,
  StreamingState,
} from '@/modules/proxy-gateway/antigravity/ClaudeStreamingMapper';
import { MALFORMED_FUNCTION_CALL_RECOVERY_TEXT } from '@/modules/proxy-gateway/antigravity/GeminiFinishReason';
import { GenerationOutputState } from '@/modules/proxy-gateway/antigravity/GenerationOutputState';
import { toOpenAIResponsesResponse } from '@/server/gateway/modules/openai/responses/OpenAIResponsesResponseMapper';
import { OpenAIResponsesStreamingMapper } from '@/server/gateway/modules/openai/responses/OpenAIResponsesStreamingMapper';
import type { GeminiPart, GeminiResponse } from '@/modules/proxy-gateway/antigravity/types';
import { toOpenAIChatResponse } from '@/server/gateway/modules/openai/chat/openai-chat-response';

const tool = {
  name: 'shell',
  id: 'call_valid',
  args: { input: 'unchanged', metadata: { owner: 'client' }, workflow: [{ code: 'client code' }] },
};
const cases: GeminiPart[][] = [
  [],
  [{ text: 'Existing text.' }],
  [{ functionCall: tool }],
  [{ text: 'Existing text.' }, { functionCall: tool }],
];
const Event = z
  .object({
    type: z.string(),
    delta: z.unknown().optional(),
    content_block: z.unknown().optional(),
    response: z.unknown().optional(),
  })
  .passthrough();
function parse(sse: string[]) {
  return sse.flatMap((chunk) =>
    chunk
      .split('\n')
      .filter((line) => line.startsWith('data: '))
      .map((line) => Event.parse(JSON.parse(line.slice(6)))),
  );
}

describe('malformed generation across unary and streaming protocol mappers', () => {
  it.each(cases.map((parts) => ({ parts })))(
    'preserves preceding content and tools for $parts',
    ({ parts }) => {
      const hasText = parts.some((part) => part.text);
      const hasTool = parts.some((part) => part.functionCall);
      const upstream: GeminiResponse = {
        candidates: [
          { content: { role: 'model', parts }, finishReason: 'MALFORMED_FUNCTION_CALL' },
        ],
      };
      const claude = transformResponse(upstream);
      expect(claude.stop_reason).toBe(hasTool ? 'tool_use' : 'end_turn');
      expect(claude.content.filter((block) => block.type === 'text')).toEqual([
        ...(hasText ? [{ type: 'text', text: 'Existing text.' }] : []),
        { type: 'text', text: `${hasText ? '\n\n' : ''}${MALFORMED_FUNCTION_CALL_RECOVERY_TEXT}` },
      ]);
      expect(claude.content.filter((block) => block.type === 'tool_use')).toEqual(
        hasTool ? [{ type: 'tool_use', id: tool.id, name: tool.name, input: tool.args }] : [],
      );

      const response = toOpenAIResponsesResponse(
        toOpenAIChatResponse(decodeAntigravityGenerationResult(upstream), 'gemini-3-flash'),
      );
      expect(response.status).toBe('completed');
      expect(response.error).toBeNull();
      const output = z.array(z.object({ type: z.string() }).passthrough()).parse(response.output);
      expect(output.filter((item) => item.type === 'function_call')).toEqual(
        hasTool
          ? [
              expect.objectContaining({
                call_id: tool.id,
                name: tool.name,
                arguments: JSON.stringify(tool.args),
              }),
            ]
          : [],
      );
      expect(
        JSON.stringify(response.output).split(MALFORMED_FUNCTION_CALL_RECOVERY_TEXT),
      ).toHaveLength(2);

      const state = new StreamingState();
      const processor = new PartProcessor(state);
      const claudeEvents = parse([
        ...parts.flatMap((part) => processor.process(part)),
        ...state.emitFinish('MALFORMED_FUNCTION_CALL'),
      ]);
      expect(
        claudeEvents
          .filter(
            (event) =>
              event.type === 'content_block_delta' &&
              z.object({ type: z.string() }).parse(event.delta).type === 'text_delta',
          )
          .map((event) => z.object({ text: z.string() }).parse(event.delta).text),
      ).toEqual([...(hasText ? ['Existing text.'] : []), MALFORMED_FUNCTION_CALL_RECOVERY_TEXT]);
      expect(claudeEvents.find((event) => event.type === 'message_delta')?.delta).toEqual({
        stop_reason: hasTool ? 'tool_use' : 'end_turn',
        stop_sequence: null,
      });
      expect(claudeEvents.at(-1)?.type).toBe('message_stop');

      const mapper = new OpenAIResponsesStreamingMapper({
        model: 'gemini-3-flash',
        responseId: 'resp_failure',
      });
      const frame = decodeAntigravityStreamFrame(
        JSON.stringify(upstream),
        new GenerationOutputState(),
      );
      if (frame.kind !== 'response') {
        throw new Error(`Expected an Antigravity response frame, received ${frame.kind}`);
      }
      const candidate = frame.candidates[Symbol.iterator]().next().value;
      const events = parse([
        ...Array.from(candidate?.parts ?? []).flatMap((part) => [...mapper.processPart(part)]),
        ...mapper.complete(candidate?.finishReason),
      ]);
      expect(events.at(-1)?.type).toBe('response.completed');
      expect(
        z
          .object({ status: z.literal('completed'), error: z.null().optional() })
          .parse(events.at(-1)?.response),
      ).toEqual({ status: 'completed' });
      expect(
        events
          .filter((event) => event.type === 'response.output_text.delta')
          .map((event) => z.string().parse(event.delta))
          .join(''),
      ).toBe(`${hasText ? 'Existing text.\n\n' : ''}${MALFORMED_FUNCTION_CALL_RECOVERY_TEXT}`);
      expect(
        events.filter((event) => event.type === 'response.function_call_arguments.done'),
      ).toEqual(hasTool ? [expect.objectContaining({ arguments: JSON.stringify(tool.args) })] : []);
    },
  );
});
