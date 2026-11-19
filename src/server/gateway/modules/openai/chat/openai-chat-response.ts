import { isNil, isString } from 'lodash-es';
import { v4 as uuidv4 } from 'uuid';
import type { AntigravityGenerationResult } from '@/modules/proxy-gateway/antigravity/AntigravityResponseDecoder';
import {
  isDeclaredOpenAICustomTool,
  readCustomToolInput,
} from '@/modules/proxy-gateway/antigravity/CustomToolCall';
import { toOpenAIUsage } from '@/modules/proxy-gateway/antigravity/OpenAIUsageMapper';
import { splitNamespaceToolName } from '@/modules/proxy-gateway/antigravity/ToolNamespace';
import type {
  OpenAIChatRequest,
  OpenAIChatResponse,
  OpenAIToolCall,
} from '@/server/gateway/common/interfaces/request-interfaces';

const finishReasons = {
  completed: 'stop',
  output_limit: 'length',
  tool_call: 'tool_calls',
  blocked: 'content_filter',
} satisfies Record<AntigravityGenerationResult['finishReason'], string>;

function normalizeToolCallArguments(input: unknown): string {
  if (isString(input)) {
    return input;
  }
  if (isNil(input)) {
    return '{}';
  }
  try {
    return JSON.stringify(input);
  } catch {
    return '{}';
  }
}

export function toOpenAIChatResponse(
  result: AntigravityGenerationResult,
  model: string,
  clientTools?: OpenAIChatRequest['tools'],
): OpenAIChatResponse {
  const textContent = result.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text || '')
    .join('');
  const reasoningContent = result.content
    .filter((block) => block.type === 'thinking')
    .map((block) => block.thinking || '')
    .join('');
  const toolCalls = result.content
    .filter((block) => block.type === 'tool_use')
    .map((block, index): OpenAIToolCall => {
      const { name, namespace } = splitNamespaceToolName(block.name || 'unknown_tool', clientTools);
      const identity = { id: block.id || `tool-call-${index}`, namespace };
      return isDeclaredOpenAICustomTool(block.name, clientTools)
        ? {
            ...identity,
            type: 'custom',
            custom: { name, input: readCustomToolInput(block.input) },
          }
        : {
            ...identity,
            type: 'function',
            function: { name, arguments: normalizeToolCallArguments(block.input) },
          };
    });

  return {
    id: `chatcmpl-${uuidv4()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: textContent || null,
          tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
          reasoning_content: reasoningContent || undefined,
          refusal: result.refusal,
        },
        finish_reason: finishReasons[result.finishReason],
      },
    ],
    usage: toOpenAIUsage(result.usage),
  };
}
