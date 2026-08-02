import type { OpenAIChatResponse, OpenAIToolCall } from '../server/interfaces/request-interfaces';
import { optimizeApplyPatch, validateApplyPatchV4A } from './ApplyPatchPreflight';
import { extractCustomToolInput, isCustomToolCall } from './CustomToolCall';
import { toOpenAIResponsesUsage } from './OpenAIUsageMapper';

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

  if ((typeof content === 'string' && content.length > 0) || refusal) {
    output.push({
      content: refusal
        ? [
            {
              refusal,
              type: 'refusal',
            },
          ]
        : [
            {
              text: content,
              type: 'output_text',
            },
          ],
      id: `msg_${response.id}`,
      role: 'assistant',
      status: 'completed',
      type: 'message',
    });
  }

  for (const toolCall of choice?.message.tool_calls ?? []) {
    const mapped = toResponsesToolOutputItem(toolCall);
    if ('diagnostic' in mapped) {
      output.push({
        content: [{ text: mapped.diagnostic, type: 'output_text' }],
        id: `msg_${toolCall.id}`,
        role: 'assistant',
        status: 'completed',
        type: 'message',
      });
    } else {
      output.push(mapped.item);
    }
  }

  return {
    created_at: response.created,
    id: response.id,
    model: response.model,
    object: 'response',
    output,
    status: 'completed',
    type: 'response',
    usage: toOpenAIResponsesUsage(response.usage),
  };
}
