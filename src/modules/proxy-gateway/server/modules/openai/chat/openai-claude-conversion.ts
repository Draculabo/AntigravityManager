/**
 * Pure request and response conversion between the OpenAI surface and the Claude shape the
 * gateway speaks internally. Extracted from `OpenAIService` with no behavior change: these
 * functions never touched instance state, only each other.
 *
 * `OpenAIService` remains the protocol owner and keeps the orchestration. This module holds
 * only the mapping it delegates to.
 */

import { isEmpty, isNil, isPlainObject, isString } from 'lodash-es';
import { v4 as uuidv4 } from 'uuid';
import {
  extractCustomToolInput,
  isCustomToolCall,
  toCustomToolArguments,
} from '@/modules/proxy-gateway/antigravity/CustomToolCall';
import { optimizeApplyPatch } from '@/modules/proxy-gateway/antigravity/ApplyPatchPreflight';
import { normalizeObjectJsonSchema } from '@/modules/proxy-gateway/antigravity/JsonSchemaUtils';
import { toOpenAIUsage } from '@/modules/proxy-gateway/antigravity/OpenAIUsageMapper';
import { resolveShellToolName } from '@/modules/proxy-gateway/antigravity/ShellToolName';
import { sanitizeSystemInstructionForCache } from '@/modules/proxy-gateway/antigravity/StablePromptPrefix';
import {
  flattenOpenAITools,
  splitNamespaceToolName,
} from '@/modules/proxy-gateway/antigravity/ToolNamespace';
import { ClaudeRequest, ClaudeResponse } from '@/modules/proxy-gateway/antigravity/types';
import {
  AnthropicChatRequest,
  AnthropicContent,
  OpenAIChatRequest,
  OpenAIChatResponse,
} from '@/modules/proxy-gateway/server/common/interfaces/request-interfaces';

export function convertOpenAIToClaude(
  request: OpenAIChatRequest,
  signatureSessionKey?: string,
): ClaudeRequest {
  const messages = request.messages || [];
  const systemPromptParts: string[] = [];
  const seenSystemPromptKeys = new Set<string>();
  const anthropicMessages: ClaudeRequest['messages'] = [];
  const addSystemPrompt = (text: string) => {
    const trimmed = text.trim();
    const key = sanitizeSystemInstructionForCache(trimmed).split(/\s+/).join(' ');
    if (key && !seenSystemPromptKeys.has(key)) {
      seenSystemPromptKeys.add(key);
      systemPromptParts.push(trimmed);
    }
  };

  for (const msg of messages) {
    if (msg.role === 'system' || msg.role === 'developer') {
      const systemText = extractOpenAITextContent(msg.content);
      if (systemText) {
        addSystemPrompt(systemText);
      }
      continue;
    }

    if (msg.role === 'tool') {
      const toolResultText = extractOpenAITextContent(msg.content) || '';
      anthropicMessages.push({
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: msg.tool_call_id || msg.name || `tool-result-${uuidv4()}`,
            content: toolResultText,
            is_error: false,
          },
        ],
      });
      continue;
    }

    const contentBlocks = convertOpenAIPartsToAnthropicContent(msg.content);

    if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
      for (const toolCall of msg.tool_calls) {
        const functionName =
          toolCall.function?.name ??
          (toolCall.operation || toolCall.type === 'apply_patch_call' ? 'apply_patch' : null);
        if (!functionName) {
          continue;
        }
        contentBlocks.push({
          type: 'tool_use',
          id: toolCall.call_id || toolCall.id,
          name: functionName,
          input:
            toolCall.custom_input === undefined
              ? (toolCall.operation ??
                parseOpenAIFunctionArguments(toolCall.function?.arguments ?? '{}'))
              : toCustomToolArguments(functionName, toolCall.custom_input),
        });
      }
    }

    anthropicMessages.push({
      role: msg.role === 'assistant' ? 'assistant' : 'user',
      content: contentBlocks.length > 0 ? contentBlocks : '',
    });
  }

  const systemPrompt = systemPromptParts.length > 0 ? systemPromptParts.join('\n') : undefined;

  return {
    model: request.model,
    messages: anthropicMessages,
    system: systemPrompt,
    tools: convertOpenAIToolsToAnthropicTools(request.tools),
    thinking: request.thinking
      ? {
          type: request.thinking.type ?? 'enabled',
          budget_tokens: request.thinking.budget_tokens,
          effort: request.thinking.effort,
        }
      : undefined,
    max_tokens: request.max_tokens,
    temperature: request.temperature,
    top_p: request.top_p,
    presence_penalty: request.presence_penalty,
    frequency_penalty: request.frequency_penalty,
    seed: request.seed,
    tool_choice: request.tool_choice,
    stream: request.stream,
    metadata: {
      ...(request.extra ?? {}),
      source: 'openai',
      signature_session_key: signatureSessionKey,
    },
  };
}

export function convertOpenAIPartsToAnthropicContent(
  content: OpenAIChatRequest['messages'][number]['content'],
): AnthropicContent[] {
  if (isString(content)) {
    return content.trim() ? [{ type: 'text', text: content }] : [];
  }
  if (!Array.isArray(content)) {
    return [];
  }

  const blocks: AnthropicContent[] = [];
  for (const part of content) {
    if (part.type === 'text' && part.text) {
      blocks.push({ type: 'text', text: part.text });
      continue;
    }

    if (part.type === 'image_url' && part.image_url?.url) {
      const url = part.image_url.url;
      const dataUri = url.match(/^data:(?<mime>[^;]+);base64,(?<data>.+)$/);
      if (dataUri?.groups?.mime && dataUri.groups.data) {
        blocks.push({
          type: 'image',
          source: {
            type: 'base64',
            media_type: dataUri.groups.mime,
            data: dataUri.groups.data,
          },
        });
      } else {
        blocks.push({ type: 'text', text: `[image_url] ${url}` });
      }
    }
  }
  return blocks;
}

export function extractOpenAITextContent(
  content: OpenAIChatRequest['messages'][number]['content'],
): string {
  if (isString(content)) {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }

  return content
    .filter((part) => part.type === 'text')
    .map((part) => part.text || '')
    .join('\n');
}

export function parseOpenAIFunctionArguments(argumentsString: string): Record<string, unknown> {
  if (isEmpty(argumentsString.trim())) {
    return {};
  }

  try {
    const parsed = JSON.parse(argumentsString);
    if (isPlainObject(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return { value: parsed };
  } catch {
    return { raw: argumentsString };
  }
}

export function extractOpenAIToolNames(tools: OpenAIChatRequest['tools']): ReadonlySet<string> {
  const names = new Set<string>();

  for (const tool of flattenOpenAITools(tools) ?? []) {
    const name = isString(tool.function?.name)
      ? tool.function.name
      : isString(tool.name)
        ? tool.name
        : undefined;
    if (name) {
      names.add(name);
    }
  }

  return names;
}

export function convertOpenAIToolsToAnthropicTools(
  tools: OpenAIChatRequest['tools'],
): AnthropicChatRequest['tools'] {
  if (!tools || tools.length === 0) {
    return undefined;
  }

  const result: NonNullable<AnthropicChatRequest['tools']> = [];
  const searchToolTypes = new Set([
    'web_search_20250305',
    'google_search',
    'google_search_retrieval',
    'builtin_web_search',
  ]);

  for (const tool of flattenOpenAITools(tools) ?? []) {
    if (!tool) {
      continue;
    }

    const toolType = isString(tool.type) ? tool.type.toLowerCase() : '';
    const functionName = isString(tool.function?.name)
      ? tool.function.name
      : isString(tool.name)
        ? tool.name
        : '';
    const normalizedFunctionName = functionName.toLowerCase();
    const isSearchTool =
      searchToolTypes.has(toolType) || searchToolTypes.has(normalizedFunctionName);

    if (isSearchTool) {
      result.push({
        name: functionName || 'builtin_web_search',
        type: 'web_search_20250305',
        input_schema: {
          type: 'object',
          properties: {},
        },
      });
      continue;
    }

    if (!functionName) {
      continue;
    }

    const parameters = isCustomToolCall(functionName)
      ? {
          type: 'object',
          properties: {
            input: {
              type: 'string',
              description:
                'The exact freeform V4A patch text to pass to Codex apply_patch. It must start with *** Begin Patch and end with *** End Patch. Do not wrap it in a shell command or command array.',
            },
          },
          required: ['input'],
        }
      : (tool.function?.parameters ??
        (isPlainObject(tool.parameters)
          ? (tool.parameters as Record<string, unknown>)
          : {
              type: 'object',
              properties: {
                content: {
                  type: 'string',
                  description: 'The raw content or patch to be applied',
                },
              },
              required: ['content'],
            }));
    const inputSchema = normalizeObjectJsonSchema(parameters);

    result.push({
      name: functionName,
      description:
        tool.function?.description ?? (isString(tool.description) ? tool.description : undefined),
      input_schema: inputSchema,
    });
  }

  return result.length > 0 ? result : undefined;
}

export function mapGeminiFinishReasonToOpenAIFinishReason(finishReason?: string): string | null {
  if (!finishReason) {
    return null;
  }

  const normalized = finishReason.toUpperCase();
  if (normalized === 'STOP') {
    return 'stop';
  }
  if (normalized === 'MAX_TOKENS') {
    return 'length';
  }
  if (normalized === 'SAFETY' || normalized === 'RECITATION') {
    return 'content_filter';
  }

  return finishReason.toLowerCase();
}

export function mapAnthropicStopReasonToOpenAIFinishReason(
  stopReason?: string | null,
): string | null {
  if (!stopReason) {
    return null;
  }

  if (stopReason === 'end_turn') {
    return 'stop';
  }
  if (stopReason === 'max_tokens') {
    return 'length';
  }
  if (stopReason === 'tool_use') {
    return 'tool_calls';
  }

  return stopReason;
}

export function normalizeToolCallArguments(input: unknown): string {
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

// Convert Claude response to OpenAI format
export function convertClaudeToOpenAIResponse(
  claudeResponse: ClaudeResponse,
  model: string,
  clientToolNames?: ReadonlySet<string>,
): OpenAIChatResponse {
  const contentBlocks = Array.isArray(claudeResponse?.content) ? claudeResponse.content : [];

  const textContent = contentBlocks
    .filter(
      (
        block,
      ): block is Extract<ClaudeResponse['content'][number], { type: 'text'; text: string }> =>
        block?.type === 'text',
    )
    .map((block) => block.text || '')
    .join('');

  const reasoningContent = contentBlocks
    .filter(
      (
        block,
      ): block is Extract<
        ClaudeResponse['content'][number],
        { type: 'thinking'; thinking: string }
      > => block?.type === 'thinking',
    )
    .map((block) => block.thinking || '')
    .join('');

  const toolCalls = contentBlocks
    .filter(
      (
        block,
      ): block is Extract<
        ClaudeResponse['content'][number],
        { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
      > => block?.type === 'tool_use',
    )
    .map((block, index: number) => {
      const splitName = splitNamespaceToolName(block.name || 'unknown_tool');
      const functionName = clientToolNames
        ? resolveShellToolName(splitName.name, clientToolNames)
        : splitName.name;
      const argumentsInput = isCustomToolCall(functionName)
        ? toCustomToolArguments(
            functionName,
            optimizeApplyPatch(extractCustomToolInput(functionName, block.input)).input,
          )
        : block.input;
      return {
        id: block.id || `tool-call-${index}`,
        type: 'function' as const,
        function: {
          name: functionName,
          arguments: normalizeToolCallArguments(argumentsInput),
        },
        namespace: splitName.namespace,
      };
    });

  return {
    id: `chatcmpl-${uuidv4()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: model,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: textContent || null,
          tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
          reasoning_content: reasoningContent || undefined,
          refusal: claudeResponse.refusal,
        },
        finish_reason: mapAnthropicStopReasonToOpenAIFinishReason(claudeResponse.stop_reason),
      },
    ],
    usage: toOpenAIUsage(claudeResponse.usage),
  };
}
