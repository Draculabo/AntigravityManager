import type {
  OpenAIChatResponse,
  OpenAIToolCall,
} from '../../../common/interfaces/request-interfaces';
import {
  isMalformedFunctionCallFinishReason,
  MALFORMED_FUNCTION_CALL_RECOVERY_TEXT,
} from '@/modules/proxy-gateway/antigravity/GeminiFinishReason';
import { toOpenAIResponsesUsage } from '@/modules/proxy-gateway/antigravity/OpenAIUsageMapper';
import { normalizeStructuredOpenAIChoice } from '../openai-structured-output';
import { toIncompleteReason, type ResponsesOutputStatus } from './openai-responses-incomplete';
import type {
  ResponsesOutputTextPart,
  ResponsesReasoningOutputItem,
} from './openai-responses-output';
import type { ResponsesToolCallOutputItem } from './responses-tool-call-projection';

type ResponsesMessageContentPart = ResponsesOutputTextPart | { refusal: string; type: 'refusal' };

type ResponsesOutputItem =
  | {
      content: ResponsesMessageContentPart[];
      id: string;
      role: 'assistant';
      status: ResponsesOutputStatus;
      type: 'message';
    }
  | ResponsesReasoningOutputItem
  | ResponsesToolCallOutputItem;

function toResponsesToolOutputItem(
  toolCall: OpenAIToolCall,
): ResponsesToolCallOutputItem | undefined {
  const common = {
    call_id: toolCall.call_id ?? toolCall.id,
    id: toolCall.id,
    ...(toolCall.namespace ? { namespace: toolCall.namespace } : {}),
    status: 'completed' as const,
  };
  if (toolCall.type === 'custom' && toolCall.custom) {
    return { ...common, ...toolCall.custom, type: 'custom_tool_call' };
  }
  if (toolCall.function) {
    return { ...common, ...toolCall.function, type: 'function_call' };
  }
  if (toolCall.type === 'apply_patch_call' && toolCall.operation) {
    return {
      ...common,
      name: 'apply_patch',
      arguments: JSON.stringify(toolCall.operation),
      type: 'function_call',
    };
  }
}

export function toOpenAIResponsesResponse(
  response: OpenAIChatResponse,
  responseId = response.id,
  structuredOutput = false,
) {
  const choice = response.choices[0];
  const output: ResponsesOutputItem[] = [];
  const rawContent = choice?.message.content;
  const refusal = choice?.message.refusal;
  const answer =
    structuredOutput && choice
      ? normalizeStructuredOpenAIChoice(choice).message.content
      : rawContent;
  const content = isMalformedFunctionCallFinishReason(choice?.finish_reason)
    ? [typeof rawContent === 'string' ? rawContent : '', MALFORMED_FUNCTION_CALL_RECOVERY_TEXT]
        .filter(Boolean)
        .join('\n\n')
    : answer;
  const reasoningContent = choice?.message.reasoning_content;
  // Upstream already said whether the answer ran out of output budget; a response
  // that reports `completed` regardless makes a truncated answer look final.
  const incompleteReason = toIncompleteReason(choice?.finish_reason);
  const status: ResponsesOutputStatus = incompleteReason ? 'incomplete' : 'completed';
  if (reasoningContent?.trim()) {
    output.push({
      summary: [
        {
          text: reasoningContent,
          type: 'summary_text',
        },
      ],
      id: `reasoning_${responseId}`,
      status,
      type: 'reasoning',
    });
  }

  if ((typeof content === 'string' && content.length > 0) || refusal) {
    const contentParts: ResponsesMessageContentPart[] = [];
    if (typeof content === 'string' && content.length > 0) {
      contentParts.push({
        annotations: [],
        text: content,
        type: 'output_text',
      });
    }
    if (refusal) {
      contentParts.push({
        refusal,
        type: 'refusal',
      });
    }

    output.push({
      content: contentParts,
      id: `msg_${responseId}`,
      role: 'assistant',
      status,
      type: 'message',
    });
  }

  for (const toolCall of choice?.message.tool_calls ?? []) {
    const item = toResponsesToolOutputItem(toolCall);
    if (item) {
      output.push(item);
    }
  }

  const usage = toOpenAIResponsesUsage(response.usage);
  return {
    created_at: response.created,
    error: null,
    id: responseId,
    incomplete_details: incompleteReason ? { reason: incompleteReason } : null,
    model: response.model,
    object: 'response' as const,
    output,
    status,
    type: 'response' as const,
    usage: {
      ...usage,
      input_tokens_details: {
        ...usage.input_tokens_details,
        cached_tokens: usage.input_tokens_details?.cached_tokens ?? 0,
      },
      output_tokens_details: {
        ...usage.output_tokens_details,
        reasoning_tokens: usage.output_tokens_details?.reasoning_tokens ?? 0,
      },
    },
  };
}
