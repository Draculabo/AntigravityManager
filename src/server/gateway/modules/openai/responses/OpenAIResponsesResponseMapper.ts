import type {
  OpenAIChatResponse,
  OpenAIToolCall,
} from '../../../common/interfaces/request-interfaces';
import {
  isMalformedFunctionCallFinishReason,
  MALFORMED_FUNCTION_CALL_RECOVERY_TEXT,
} from '@/modules/proxy-gateway/antigravity/GeminiFinishReason';
import { toOpenAIResponsesUsage } from '@/modules/proxy-gateway/antigravity/OpenAIUsageMapper';
import { toIncompleteReason, type ResponsesOutputStatus } from './openai-responses-incomplete';

function toResponsesToolOutputItem(toolCall: OpenAIToolCall): Record<string, unknown> | undefined {
  const common = {
    call_id: toolCall.call_id ?? toolCall.id,
    id: toolCall.id,
    ...(toolCall.namespace ? { namespace: toolCall.namespace } : {}),
    status: 'completed',
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

function unwrapStructuredJson(text: string): string {
  const fenced = /^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/iu.exec(text.trim());
  if (fenced?.[1] === undefined) {
    return text;
  }
  const payload = fenced[1].trim();
  try {
    JSON.parse(payload);
    return payload;
  } catch {
    return text;
  }
}

export function toOpenAIResponsesResponse(
  response: OpenAIChatResponse,
  responseId = response.id,
  structuredOutput = false,
): Record<string, unknown> {
  const choice = response.choices[0];
  const output: Record<string, unknown>[] = [];
  const rawContent = choice?.message.content;
  const refusal = choice?.message.refusal;
  const answer =
    structuredOutput &&
    choice?.finish_reason === 'stop' &&
    !refusal &&
    !choice.message.tool_calls?.length &&
    typeof rawContent === 'string'
      ? unwrapStructuredJson(rawContent)
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
    const contentParts: Record<string, unknown>[] = [];
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
    object: 'response',
    output,
    status,
    type: 'response',
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
