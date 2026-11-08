import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';
import type { OpenAIChatRequest } from '../../../common/interfaces/request-interfaces';
import {
  parseResponsesRequestBody,
  type ResponsesRequestBody,
} from '../responses/openai-responses-request';
import { parseResponsesInputItem } from '../responses/responses-input-item';

const CompatibilityEnvelope = z.object({
  input: z.union([z.string(), z.array(z.unknown())]).optional(),
  previous_response_id: z.string().min(1).optional(),
  stream_options: z
    .object({ include_usage: z.boolean().optional() })
    .strict()
    .nullable()
    .optional(),
});
const MessageRole = z.object({ role: z.string().optional() });
const ReasoningItem = z.object({ type: z.literal('reasoning') });

type ChatResponsesRequest = ResponsesRequestBody & Pick<OpenAIChatRequest, 'stream_options'>;

/** Decode the alternate HTTP body before invoking the typed Chat generation path. */
export function parseChatResponsesCompatibility(body: unknown): ChatResponsesRequest | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new BadRequestException('Expected an OpenAI request object');
  }
  if (
    Object.hasOwn(body, 'messages') ||
    !['input', 'instructions', 'previous_response_id'].some((key) => Object.hasOwn(body, key))
  ) {
    return null;
  }
  const request = parseResponsesRequestBody(body);
  const envelope = CompatibilityEnvelope.safeParse(body);
  if (!request || !envelope.success) {
    throw new BadRequestException('Invalid Responses input for Chat Completions');
  }
  if (Array.isArray(envelope.data.input)) {
    for (const item of envelope.data.input) {
      const parsed = parseResponsesInputItem(item);
      if (
        (!parsed && !ReasoningItem.safeParse(item).success) ||
        (parsed?.type === 'message' && !MessageRole.safeParse(item).success)
      ) {
        throw new BadRequestException('Invalid Responses input item for Chat Completions');
      }
    }
  }
  return { ...request, stream_options: envelope.data.stream_options };
}
