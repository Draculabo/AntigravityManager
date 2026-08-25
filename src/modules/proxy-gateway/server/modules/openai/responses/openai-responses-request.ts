/**
 * Normalisation of the OpenAI Responses request shape into the chat request the gateway
 * already knows how to serve, plus the small guards it needs. Extracted from
 * `OpenAIOperations` with no behavior change: this cluster only referenced itself.
 *
 * Entry controllers keep the routes, `OpenAIOperations` keeps orchestration, and this module
 * holds the mapping.
 */

import { isEmpty, isNil, isPlainObject, isString } from 'lodash-es';
import { ApplyPatchFailureCompactor } from '@/modules/proxy-gateway/antigravity/ApplyPatchFailureCompaction';
import { toCustomToolArguments } from '@/modules/proxy-gateway/antigravity/CustomToolCall';
import {
  OpenAIChatRequest,
  OpenAIContentPart,
  OpenAIToolCall,
} from '@/modules/proxy-gateway/server/common/interfaces/request-interfaces';

export interface ResponsesRequestBody {
  model?: string;
  instructions?: string;
  input?: unknown;
  metadata?: Record<string, unknown>;
  previous_response_id?: string;
  store?: boolean;
  tools?: OpenAIChatRequest['tools'];
  max_output_tokens?: number;
  temperature?: number;
  top_p?: number;
  presence_penalty?: number;
  frequency_penalty?: number;
  seed?: number;
  tool_choice?: OpenAIChatRequest['tool_choice'];
  stream?: boolean;
  user?: string;
}

export interface OpenAIResponsesErrorBody {
  error: {
    code: string;
    message: string;
    param: string;
    type: string;
  };
}

/**
 * The answer to a response id this gateway cannot serve.
 *
 * OpenAI reports an unknown or aged-out id as 404 in the standard error
 * envelope, and clients read that as "start a fresh conversation". Answering
 * 400 instead reads as a malformed request, and serving an empty chain reads to
 * the user as the assistant losing its memory. The `code` is ours: the status,
 * the envelope and `param` are the parts the API documents.
 */
export function buildResponseNotFoundError(
  responseId: string,
  param: 'id' | 'previous_response_id' = 'previous_response_id',
): OpenAIResponsesErrorBody {
  return {
    error: {
      code: param === 'id' ? 'response_not_found' : 'previous_response_not_found',
      message: `${param === 'id' ? 'Response' : 'Previous response'} with id '${responseId}' not found.`,
      param,
      type: 'invalid_request_error',
    },
  };
}

export function normalizeResponsesInputItems(input: unknown): unknown[] {
  if (Array.isArray(input)) {
    return input;
  }
  if (isNil(input)) {
    return [];
  }

  const content = isString(input) ? input : normalizeResponsesInput(input);
  return [
    {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: content }],
    },
  ];
}

export function extractCompletedResponsesEvent(event: unknown): unknown | null {
  if (!isString(event)) {
    return null;
  }

  const dataLine = event.split(/\r?\n/).find((line) => line.startsWith('data:'));
  if (!dataLine) {
    return null;
  }

  try {
    const parsed = toRecord(JSON.parse(dataLine.slice('data:'.length).trimStart()));
    return parsed?.type === 'response.completed' ? (parsed.response ?? null) : null;
  } catch {
    return null;
  }
}

export function normalizeResponsesInput(input: unknown): string {
  if (isString(input)) {
    return input;
  }

  if (Array.isArray(input)) {
    return input
      .map((item) => {
        if (isString(item)) {
          return item;
        }
        const itemRecord = toRecord(item);
        const content = asString(itemRecord?.content);
        if (content) {
          return content;
        }
        return JSON.stringify(item);
      })
      .join('\n');
  }

  if (isNil(input)) {
    return '';
  }

  return JSON.stringify(input);
}

export function buildResponsesChatRequest(body: ResponsesRequestBody): OpenAIChatRequest {
  const messages: OpenAIChatRequest['messages'] = [];
  if (isString(body.instructions) && !isEmpty(body.instructions.trim())) {
    messages.push({
      role: 'system',
      content: body.instructions,
    });
  }

  const callIdToToolName = new Map<string, string>();
  const incompleteCustomCallIds = new Set<string>();
  const applyPatchFailureCompactor = new ApplyPatchFailureCompactor();
  const inputItems = Array.isArray(body.input) ? body.input : null;

  if (inputItems) {
    for (const item of inputItems) {
      const itemObj = toRecord(item);
      if (!itemObj) {
        continue;
      }

      const type = asString(itemObj.type);
      if (!type) {
        continue;
      }

      if (
        type === 'function_call' ||
        type === 'local_shell_call' ||
        type === 'web_search_call' ||
        type === 'custom_tool_call'
      ) {
        const callId = asString(itemObj.call_id) ?? asString(itemObj.id) ?? `call_${Date.now()}`;
        if (
          type === 'custom_tool_call' &&
          asString(itemObj.status)?.toLowerCase() === 'incomplete'
        ) {
          incompleteCustomCallIds.add(callId);
          continue;
        }

        const toolName =
          type === 'local_shell_call'
            ? 'shell'
            : type === 'web_search_call'
              ? 'builtin_web_search'
              : (asString(itemObj.name) ?? 'unknown');
        callIdToToolName.set(callId, toolName);
      }
    }

    for (const item of inputItems) {
      const itemObj = toRecord(item);
      if (!itemObj) {
        continue;
      }

      const type = asString(itemObj.type);
      if (!type) {
        continue;
      }

      if (type === 'message') {
        const role = asString(itemObj.role) ?? 'user';
        const content = normalizeResponsesMessageContent(itemObj.content);
        messages.push({ role, content });
        continue;
      }

      if (
        type === 'function_call' ||
        type === 'local_shell_call' ||
        type === 'web_search_call' ||
        type === 'custom_tool_call'
      ) {
        const callId = asString(itemObj.call_id) ?? asString(itemObj.id) ?? `call_${Date.now()}`;
        if (incompleteCustomCallIds.has(callId)) {
          continue;
        }

        const toolName = callIdToToolName.get(callId) ?? 'unknown';
        const customInput =
          type === 'custom_tool_call' ? (asString(itemObj.input) ?? '') : undefined;
        const args =
          customInput === undefined
            ? resolveToolArguments(type, itemObj)
            : toCustomToolArguments(toolName, customInput);
        const toolCall: OpenAIToolCall = {
          id: callId,
          type: 'function',
          function: {
            name: toolName,
            arguments: JSON.stringify(args),
          },
        };
        if (customInput !== undefined) {
          toolCall.custom_input = customInput;
        }
        messages.push({
          role: 'assistant',
          content: '',
          tool_calls: [toolCall],
        });
        continue;
      }

      if (type === 'function_call_output' || type === 'custom_tool_call_output') {
        const callId = asString(itemObj.call_id) ?? asString(itemObj.id) ?? 'unknown';
        if (incompleteCustomCallIds.has(callId)) {
          continue;
        }
        if (type === 'custom_tool_call_output' && !callIdToToolName.has(callId)) {
          continue;
        }

        const toolName = callIdToToolName.get(callId) ?? 'unknown';
        const normalizedOutput = normalizeResponsesOutput(itemObj.output);
        const output =
          toolName === 'apply_patch'
            ? applyPatchFailureCompactor.compact(normalizedOutput)
            : normalizedOutput;
        messages.push({
          role: 'tool',
          tool_call_id: callId,
          name: toolName,
          content: output,
        });
        continue;
      }
    }
  } else if (isString(body.input)) {
    messages.push({
      role: 'user',
      content: body.input,
    });
  } else if (!isNil(body.input)) {
    messages.push({
      role: 'user',
      content: normalizeResponsesInput(body.input),
    });
  }

  if (messages.length === 0) {
    messages.push({
      role: 'user',
      content: '',
    });
  }

  return {
    model: body.model ?? 'gemini-3-flash',
    messages,
    tools: body.tools,
    max_tokens: body.max_output_tokens,
    temperature: body.temperature,
    top_p: body.top_p,
    presence_penalty: body.presence_penalty,
    frequency_penalty: body.frequency_penalty,
    seed: body.seed,
    tool_choice: body.tool_choice,
    stream: body.stream,
    extra: {
      ...(body.metadata ?? {}),
      previous_response_id: body.previous_response_id,
      user_id: body.user,
    },
  };
}

export function normalizeResponsesMessageContent(content: unknown): string | OpenAIContentPart[] {
  if (isString(content)) {
    return content;
  }

  if (!Array.isArray(content)) {
    return normalizeResponsesInput(content);
  }

  const textParts: string[] = [];
  const imageParts: OpenAIContentPart[] = [];

  for (const item of content) {
    const block = toRecord(item);
    if (!block) {
      continue;
    }

    const blockType = asString(block.type);
    if (blockType === 'input_text' || blockType === 'text' || blockType === 'output_text') {
      const text = asString(block.text);
      if (text) {
        textParts.push(text);
      }
      continue;
    }

    if (blockType === 'input_image' || blockType === 'image_url') {
      const imageUrl = resolveImageUrl(block);
      if (imageUrl) {
        imageParts.push({
          type: 'image_url',
          image_url: {
            url: imageUrl,
          },
        });
      }
    }
  }

  if (imageParts.length === 0) {
    return textParts.join('\n');
  }

  const merged: OpenAIContentPart[] = [];
  if (textParts.length > 0) {
    merged.push({
      type: 'text',
      text: textParts.join('\n'),
    });
  }
  merged.push(...imageParts);
  return merged;
}

export function resolveToolArguments(
  type: string,
  item: Record<string, unknown>,
): Record<string, unknown> {
  if (type === 'local_shell_call') {
    const action = toRecord(item.action);
    const exec = action ? toRecord(action.exec) : null;
    const command = asString(exec?.command);
    return {
      command: command ? [command] : [],
    };
  }

  if (type === 'web_search_call') {
    const action = toRecord(item.action);
    return {
      query: asString(action?.query) ?? '',
    };
  }

  const raw = item.arguments;
  if (isString(raw)) {
    try {
      const parsed = JSON.parse(raw);
      const parsedRecord = toRecord(parsed);
      if (parsedRecord) {
        return parsedRecord;
      }
      return {
        value: parsed,
      };
    } catch {
      return {
        raw,
      };
    }
  }

  const rawRecord = toRecord(raw);
  if (rawRecord) {
    return rawRecord;
  }

  return {};
}

export function normalizeResponsesOutput(output: unknown): string {
  if (isString(output)) {
    return output;
  }
  const outputRecord = toRecord(output);
  const content = asString(outputRecord?.content);
  if (content) {
    return content;
  }
  if (isNil(output)) {
    return '';
  }
  return JSON.stringify(output);
}

export function resolveImageUrl(block: Record<string, unknown>): string | null {
  const raw = block.image_url;
  if (isString(raw)) {
    return raw;
  }
  const rawRecord = toRecord(raw);
  const url = asString(rawRecord?.url);
  if (url) {
    return url;
  }
  return null;
}

export function resolveInlineData(
  input: unknown,
  defaultMimeType: string,
): {
  mimeType: string;
  data: string;
} | null {
  if (!input) {
    return null;
  }

  if (isString(input)) {
    const dataUri = input.match(/^data:(?<mime>[^;]+);base64,(?<data>[A-Za-z0-9+/=]+)$/);
    if (dataUri?.groups?.mime && dataUri.groups.data) {
      return {
        mimeType: dataUri.groups.mime,
        data: dataUri.groups.data,
      };
    }

    const cleaned = input.replace(/\s+/g, '');
    if (cleaned.length > 0) {
      return {
        mimeType: defaultMimeType,
        data: cleaned,
      };
    }
    return null;
  }

  const inputRecord = toRecord(input);
  if (inputRecord) {
    const data = asString(inputRecord.data);
    if (!data) {
      return null;
    }
    return {
      mimeType: asString(inputRecord.mimeType) ?? defaultMimeType,
      data,
    };
  }

  return null;
}

export function toRecord(value: unknown): Record<string, unknown> | null {
  if (!isPlainObject(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

export function asString(value: unknown): string | null {
  return isString(value) ? value : null;
}
