/**
 * Converts OpenAI requests into the shared generation input.
 * Client thinking control preserves explicit budgets, effort and disabled settings.
 *
 * `OpenAIService` remains the protocol owner and keeps the orchestration. This module holds
 * only the mapping it delegates to.
 */

import { BadRequestException } from '@nestjs/common';
import { getServerConfig } from '@/server/server-config';
import { recordPromptTransformation } from '../../../common/prompt-transformation-diagnostics';
import { isEmpty, isPlainObject, isString } from 'lodash-es';
import { mapGeminiFinishReasonToOpenAI } from '@/modules/proxy-gateway/antigravity/GeminiFinishReason';
import { normalizeObjectJsonSchema } from '@/modules/proxy-gateway/antigravity/JsonSchemaUtils';
import { isGoogleSearchToolType } from '@/modules/proxy-gateway/antigravity/ToolChoiceCompat';
import { SchemaConversionBatch } from '@/modules/proxy-gateway/antigravity/schema/SchemaConversion';
import { InvalidToolResultAssociationError } from '@/modules/proxy-gateway/antigravity/ClaudeToolResultAssociation';
import {
  flattenOpenAITools,
  getOpenAIToolName,
} from '@/modules/proxy-gateway/antigravity/ToolNamespace';
import { hashSessionAnchor } from '@/server/gateway/common/session-anchor-hash';
import {
  resolveGenerationOutput,
  type AntigravityGenerationInput,
} from '@/modules/proxy-gateway/antigravity/generation-input';
import type { ContentBlock, Tool } from '@/modules/proxy-gateway/antigravity/types';
import { resolveOpenAIImageUrl } from '../openai-image-url';
import { parseOpenAIInputAudio } from './openai-input-audio';
import { resolveOpenAIVideoUrl } from './openai-video-url';
import {
  OpenAIChatRequest,
  OpenAIContentPart,
  OpenAIToolCall,
} from '@/server/gateway/common/interfaces/request-interfaces';
import type { PreparedOpenAISchemas } from './openai-schema-preparation';

export interface OpenAIConversionOptions {
  allowLocalVideoPaths?: boolean;
  preparedSchemas?: PreparedOpenAISchemas['schemas'];
}

export class InvalidOpenAIToolArgumentsError extends BadRequestException {
  constructor(reason: 'invalid-json' | 'non-object' | 'invalid-custom-input') {
    super(`Invalid function tool arguments: ${reason}`);
    this.name = 'InvalidOpenAIToolArgumentsError';
  }
}

function resolveOpenAIChatToolIdentity(
  toolCall: OpenAIToolCall,
): { name: string; arguments: Record<string, unknown> } | null {
  if (toolCall.type === 'custom') {
    if (
      !isString(toolCall.custom?.name) ||
      !toolCall.custom.name ||
      !isString(toolCall.custom.input)
    ) {
      throw new InvalidOpenAIToolArgumentsError('invalid-custom-input');
    }
    return { name: toolCall.custom.name, arguments: { input: toolCall.custom.input } };
  }
  const name =
    toolCall.function?.name ??
    (toolCall.operation || toolCall.type === 'apply_patch_call' ? 'apply_patch' : null);
  if (!name) {
    return null;
  }

  return {
    name,
    arguments:
      toolCall.custom_input === undefined
        ? (toolCall.operation ?? parseOpenAIFunctionArguments(toolCall.function?.arguments ?? '{}'))
        : { input: toolCall.custom_input },
  };
}

/**
 * Give missing Chat tool IDs a stable identity and reject results that cannot be
 * associated with exactly one preceding call before account selection.
 */
export function normalizeOpenAIChatToolCallIds(request: OpenAIChatRequest): OpenAIChatRequest {
  const sourceMessages = request.messages ?? [];
  const needsGeneratedId = sourceMessages.some(
    (message) =>
      message.role === 'assistant' &&
      Array.isArray(message.tool_calls) &&
      message.tool_calls.some((toolCall) => !(toolCall.call_id || toolCall.id)),
  );
  let anchor = needsGeneratedId ? hashSessionAnchor(['openai-chat-tool-identity:v1']) : '';
  const pending = new Set<string>();
  let changed = false;
  const messages = sourceMessages.map((message, messageIndex) => {
    let normalizedMessage = message;

    if (message.role === 'assistant' && Array.isArray(message.tool_calls)) {
      const messageAnchor = needsGeneratedId
        ? hashSessionAnchor([anchor, 'assistant-message', message.content, message.name])
        : '';
      let messageChanged = false;
      const toolCalls = message.tool_calls.map((toolCall, callIndex) => {
        const identity = resolveOpenAIChatToolIdentity(toolCall);
        if (!identity) {
          return toolCall;
        }

        const suppliedId = toolCall.call_id || toolCall.id;
        const id =
          suppliedId ||
          `call_${hashSessionAnchor([
            messageAnchor,
            'tool-call',
            callIndex,
            identity.name,
            identity.arguments,
          ]).slice(0, 32)}`;
        if (pending.has(id)) {
          throw new InvalidToolResultAssociationError(
            `messages[${messageIndex}].tool_calls[${callIndex}]`,
            'duplicate-pending-id',
          );
        }
        pending.add(id);

        if (suppliedId) {
          return toolCall;
        }
        messageChanged = true;
        return { ...toolCall, id };
      });

      if (messageChanged) {
        normalizedMessage = { ...message, tool_calls: toolCalls };
      }
    } else if (message.role === 'tool') {
      let toolCallId = message.tool_call_id;
      if (!toolCallId) {
        if (pending.size !== 1) {
          throw new InvalidToolResultAssociationError(
            `messages[${messageIndex}]`,
            pending.size > 1 ? 'ambiguous-missing-id' : 'missing-pending-call',
          );
        }
        toolCallId = [...pending][0];
        normalizedMessage = { ...message, tool_call_id: toolCallId };
        changed = true;
      } else if (!pending.has(toolCallId)) {
        throw new InvalidToolResultAssociationError(
          `messages[${messageIndex}]`,
          'missing-pending-call',
        );
      }
      pending.delete(toolCallId);
    }

    changed ||= normalizedMessage !== message;
    if (needsGeneratedId) {
      anchor = hashSessionAnchor([anchor, 'message', normalizedMessage]);
    }
    return normalizedMessage;
  });

  return changed ? { ...request, messages } : request;
}

interface OpenAIPartsConversionOptions extends OpenAIConversionOptions {
  remoteImageFallback?: (url: string) => string;
  unreadableAudioFallback?: () => string;
  unreadableVideoFallback?: () => string;
}

export function toOpenAIGenerationInput(
  request: OpenAIChatRequest,
  signatureSessionKey?: string,
  options: OpenAIConversionOptions = {},
): AntigravityGenerationInput {
  request = normalizeOpenAIChatToolCallIds(request);
  const messages = request.messages || [];
  const systemPromptParts: string[] = [];
  const generationMessages: AntigravityGenerationInput['messages'] = [];
  let initialSystemSection = true;

  for (const [messageIndex, msg] of messages.entries()) {
    if (initialSystemSection) {
      if (msg.role === 'system' || msg.role === 'developer') {
        const systemText = extractOpenAITextContent(msg.content);
        if (systemText !== '') {
          systemPromptParts.push(systemText);
          recordPromptTransformation({
            kind: 'initial-system-promoted',
            surface: 'messages',
            message: messageIndex,
            part: null,
          });
        }
        continue;
      }
      initialSystemSection = false;
    }

    if (msg.role === 'system' || msg.role === 'developer') {
      const systemText = extractOpenAITextContent(msg.content);
      if (systemText !== '') {
        recordPromptTransformation({
          kind: 'late-system-reminder',
          surface: 'messages',
          message: messageIndex,
          part: null,
        });
        generationMessages.push({
          role: 'user',
          content: [
            {
              type: 'text',
              text: wrapSystemReminder(systemText),
            },
          ],
        });
      }
      continue;
    }

    if (msg.role === 'tool') {
      const toolCallId = msg.tool_call_id;
      if (!toolCallId) {
        throw new InvalidToolResultAssociationError(
          `messages[${messageIndex}]`,
          'missing-pending-call',
        );
      }
      const toolContent = convertOpenAIGenerationContent(msg.content, {
        allowLocalVideoPaths: options.allowLocalVideoPaths,
        remoteImageFallback: () => '[image link]',
        unreadableAudioFallback: () => '[audio]',
        unreadableVideoFallback: () => '[video]',
      });
      const toolResultText = toolContent
        .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
        .map((block) => block.text)
        .join('\n');
      const toolMedia = toolContent.filter(
        (block) =>
          block.type === 'image' ||
          block.type === 'audio' ||
          block.type === 'video' ||
          block.type === 'document',
      );
      const toolResultContent: string | ContentBlock[] =
        toolMedia.length === 0
          ? toolResultText
          : [
              ...(toolResultText === ''
                ? []
                : ([{ type: 'text', text: toolResultText }] satisfies ContentBlock[])),
              ...toolMedia,
            ];
      generationMessages.push({
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: toolCallId,
            content: toolResultContent,
            is_error: false,
          },
        ],
      });
      continue;
    }

    const contentBlocks = convertOpenAIGenerationContent(msg.content, {
      allowLocalVideoPaths: options.allowLocalVideoPaths,
    });

    if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
      for (const toolCall of msg.tool_calls) {
        const tool = resolveOpenAIChatToolIdentity(toolCall);
        if (!tool) {
          continue;
        }
        contentBlocks.push({
          type: 'tool_use',
          id: toolCall.call_id || toolCall.id,
          name: tool.name,
          input: tool.arguments,
        });
      }
    }

    if (contentBlocks.length === 0) {
      continue;
    }

    generationMessages.push({
      role: msg.role === 'assistant' ? 'assistant' : 'user',
      content: contentBlocks,
    });
  }

  const systemPrompt = systemPromptParts.length > 0 ? systemPromptParts.join('\n') : undefined;

  return {
    model: request.model,
    messages: generationMessages,
    system: systemPrompt,
    tools: options.preparedSchemas
      ? structuredClone(options.preparedSchemas.tools)
      : convertOpenAIGenerationTools(request.tools),
    thinking:
      getServerConfig()?.thinking_budget?.control_source === 'client'
        ? {
            type: request.thinking?.type ?? 'enabled',
            budgetTokens: request.thinking?.budget_tokens ?? request.reasoning?.max_tokens,
            effort:
              request.reasoning_effort ?? request.reasoning?.effort ?? request.thinking?.effort,
          }
        : request.thinking
          ? {
              type: request.thinking.type ?? 'enabled',
              budgetTokens: request.thinking.budget_tokens,
              effort: request.thinking.effort,
            }
          : undefined,
    parameters: {
      temperature: request.temperature ?? 1.0,
      topP: request.top_p ?? 0.95,
      presencePenalty: request.presence_penalty,
      frequencyPenalty: request.frequency_penalty,
      seed: request.seed,
      maxOutputTokens: request.max_tokens,
    },
    output: resolveGenerationOutput(
      options.preparedSchemas
        ? structuredClone(options.preparedSchemas.responseFormat)
        : request.response_format,
    ),
    toolChoice: request.tool_choice,
    signatureSessionKey,
    thinkingAfterParameters: true,
  };
}

function wrapSystemReminder(text: string): string {
  return `<system-reminder>\n${text}\n</system-reminder>`;
}

export function convertOpenAIGenerationContent(
  content: OpenAIChatRequest['messages'][number]['content'],
  options: OpenAIPartsConversionOptions = {},
): ContentBlock[] {
  if (isString(content)) {
    return content.trim() ? [{ type: 'text', text: content }] : [];
  }
  if (!Array.isArray(content)) {
    return [];
  }

  const blocks: ContentBlock[] = [];
  for (const part of content) {
    if (part.type === 'text' && part.text) {
      blocks.push({ type: 'text', text: part.text });
      continue;
    }

    const imageUrl = part.type === 'image_url' ? resolveOpenAIImageUrl(part.image_url) : null;
    if (imageUrl) {
      const url = imageUrl;
      const dataUri = parseBase64DataUrl(url, 'image/');
      if (dataUri) {
        blocks.push({
          type: 'image',
          source: {
            type: 'base64',
            media_type: dataUri.mimeType,
            data: dataUri.data,
          },
        });
      } else {
        blocks.push({
          type: 'text',
          text: (options.remoteImageFallback ?? ((fallbackUrl) => `[image_url] ${fallbackUrl}`))(
            url,
          ),
        });
      }
      continue;
    }

    if (part.type === 'audio_url') {
      const audio = resolveOpenAIAudioUrl(part.audio_url);
      if (audio) {
        blocks.push({ type: 'audio', source: audio });
      } else {
        const fallback = options.unreadableAudioFallback?.() ?? '';
        if (fallback) {
          blocks.push({ type: 'text', text: fallback });
        }
      }
      continue;
    }

    if (part.type === 'input_audio' || part.type === 'audio') {
      const audio = parseOpenAIInputAudio(part);
      blocks.push({
        type: 'audio',
        source: { type: 'base64', media_type: audio.mimeType, data: audio.data },
      });
      continue;
    }

    if (part.type === 'video_url') {
      const video = resolveOpenAIVideoUrl(part.video_url, {
        allowLocalPaths: options.allowLocalVideoPaths,
      });
      if (video) {
        blocks.push({ type: 'video', source: video });
      } else {
        const fallback = options.unreadableVideoFallback?.() ?? '';
        if (fallback) {
          blocks.push({ type: 'text', text: fallback });
        }
      }
    }
  }
  return blocks;
}

function parseBase64DataUrl(
  value: string,
  mimePrefix: string,
): { data: string; mimeType: string } | null {
  if (!value.startsWith('data:')) {
    return null;
  }
  const separator = value.indexOf(',');
  if (separator < 0) {
    return null;
  }
  const metadataParts = value.slice('data:'.length, separator).split(';');
  const mimeType = metadataParts[0] ?? '';
  if (
    !mimeType.toLowerCase().startsWith(mimePrefix) ||
    !metadataParts.slice(1).some((part) => part.toLowerCase() === 'base64')
  ) {
    return null;
  }
  const data = value.slice(separator + 1);
  return data === '' ? null : { data, mimeType };
}

function resolveOpenAIAudioUrl(
  value: OpenAIContentPart['audio_url'],
): Extract<ContentBlock, { type: 'audio' }>['source'] | null {
  if (!value || !isString(value.url) || value.url.trim() === '') {
    return null;
  }
  const url = value.url.trim();
  const inline = parseBase64DataUrl(url, 'audio/');
  if (inline) {
    return { type: 'base64', media_type: inline.mimeType, data: inline.data };
  }
  if (!/^https?:\/\//iu.test(url)) {
    return null;
  }
  const extension = url.split(/[?#]/u, 1)[0]?.split('.').pop()?.toLowerCase();
  const inferredMime =
    extension === 'wav'
      ? 'audio/wav'
      : extension === 'ogg'
        ? 'audio/ogg'
        : extension === 'flac'
          ? 'audio/flac'
          : extension === 'm4a' || extension === 'mp4'
            ? 'audio/mp4'
            : extension === 'aac'
              ? 'audio/aac'
              : 'audio/mpeg';
  const declared = (value.mime_type ?? value.mimeType ?? value.format)?.trim();
  const mediaType = declared
    ? declared.includes('/')
      ? declared.toLowerCase()
      : `audio/${declared.toLowerCase()}`
    : inferredMime;
  return { type: 'url', media_type: mediaType, url };
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
    throw new InvalidOpenAIToolArgumentsError('non-object');
  } catch (error) {
    if (error instanceof InvalidOpenAIToolArgumentsError) {
      throw error;
    }
    throw new InvalidOpenAIToolArgumentsError('invalid-json');
  }
}

export function extractOpenAIToolNames(tools: OpenAIChatRequest['tools']): ReadonlySet<string> {
  const names = new Set<string>();

  for (const tool of flattenOpenAITools(tools) ?? []) {
    const name = getOpenAIToolName(tool);
    if (name) {
      names.add(name);
    }
  }

  return names;
}

export function convertOpenAIGenerationTools(
  tools: OpenAIChatRequest['tools'],
  batch = new SchemaConversionBatch(),
): Tool[] | undefined {
  if (!tools || tools.length === 0) {
    return undefined;
  }

  const result: Tool[] = [];

  for (const tool of flattenOpenAITools(tools) ?? []) {
    if (!tool) {
      continue;
    }

    const toolType = isString(tool.type) ? tool.type.toLowerCase() : '';
    const functionName = getOpenAIToolName(tool);
    const isSearchTool = isGoogleSearchToolType(toolType);

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

    const parameters =
      toolType === 'custom'
        ? {
            type: 'object',
            properties: {
              input: {
                type: 'string',
                description: 'Pass the exact freeform text in this field.',
              },
            },
            required: ['input'],
          }
        : tool.function?.parameters !== undefined
          ? tool.function.parameters
          : tool.parameters;
    const inputSchema = normalizeObjectJsonSchema(parameters, batch, 'tool', result.length);

    result.push({
      name: functionName,
      description:
        tool.custom?.description ??
        tool.function?.description ??
        (isString(tool.description) ? tool.description : undefined),
      input_schema: inputSchema,
    });
  }

  return result.length > 0 ? result : undefined;
}

export function mapGeminiFinishReasonToOpenAIFinishReason(finishReason?: string): string | null {
  return mapGeminiFinishReasonToOpenAI(finishReason);
}
