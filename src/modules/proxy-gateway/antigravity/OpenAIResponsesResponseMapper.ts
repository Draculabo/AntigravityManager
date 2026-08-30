import type {
  OpenAIChatResponse,
  OpenAIToolCall,
} from '../server/common/interfaces/request-interfaces';
import { optimizeApplyPatch, validateApplyPatchV4A } from './ApplyPatchPreflight';
import { extractCustomToolInput, isCustomToolCall } from './CustomToolCall';
import { toOpenAIResponsesUsage } from './OpenAIUsageMapper';
import { toIncompleteReason, type ResponsesOutputStatus } from './openai-responses-incomplete';

type ResponsesToolOutput =
  | {
      diagnostic: string;
    }
  | {
      item: Record<string, unknown>;
    };

function toResponsesToolOutputItem(toolCall: OpenAIToolCall): ResponsesToolOutput {
  const functionCall = toolCall.function ?? {
    name: 'apply_patch',
    arguments: JSON.stringify(toolCall.operation ?? {}),
  };
  const callId = toolCall.call_id ?? toolCall.id;
  const namespaceFields = toolCall.namespace ? { namespace: toolCall.namespace } : {};
  if (toolCall.custom_input !== undefined || isCustomToolCall(functionCall.name)) {
    const rawInput =
      toolCall.custom_input ??
      extractCustomToolInput(functionCall.name, parseToolArguments(functionCall.arguments));
    const input = isCustomToolCall(functionCall.name)
      ? optimizeApplyPatch(rawInput).input
      : rawInput;
    if (isCustomToolCall(functionCall.name)) {
      const validationError = validateApplyPatchV4A(input);
      if (validationError) {
        return {
          diagnostic: `[apply_patch rejected: invalid V4A syntax at line ${validationError.line}: ${validationError.message}]`,
        };
      }
    }

    return {
      item: {
        call_id: callId,
        id: toolCall.id,
        input,
        name: functionCall.name,
        ...namespaceFields,
        status: 'completed',
        type: 'custom_tool_call',
      },
    };
  }

  return {
    item: {
      arguments: functionCall.arguments,
      call_id: callId,
      id: toolCall.id,
      name: functionCall.name,
      ...namespaceFields,
      status: 'completed',
      type: 'function_call',
    },
  };
}

function parseToolArguments(argumentsString: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(argumentsString);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Raw apply_patch input is handled by extractCustomToolInput's string fallback.
  }

  return {
    input: argumentsString,
  };
}

export function toOpenAIResponsesResponse(response: OpenAIChatResponse): Record<string, unknown> {
  const choice = response.choices[0];
  const output: Record<string, unknown>[] = [];
  const content = choice?.message.content;
  const refusal = choice?.message.refusal;
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
      id: `reasoning_${response.id}`,
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
      id: `msg_${response.id}`,
      role: 'assistant',
      status,
      type: 'message',
    });
  }

  for (const toolCall of choice?.message.tool_calls ?? []) {
    const mapped = toResponsesToolOutputItem(toolCall);
    if ('diagnostic' in mapped) {
      output.push({
        content: [{ annotations: [], text: mapped.diagnostic, type: 'output_text' }],
        id: `msg_${toolCall.id}`,
        phase: 'commentary',
        role: 'assistant',
        status,
        type: 'message',
      });
    } else {
      output.push(mapped.item);
    }
  }

  const usage = toOpenAIResponsesUsage(response.usage);
  return {
    created_at: response.created,
    error: null,
    id: response.id,
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
