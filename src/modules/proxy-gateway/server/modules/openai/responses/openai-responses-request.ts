/**
 * Normalisation of the OpenAI Responses request shape into the chat request the gateway
 * already knows how to serve, plus the small guards it needs. Extracted from
 * `OpenAIOperations` with no behavior change: this cluster only referenced itself.
 *
 * Entry controllers keep the routes, `OpenAIOperations` keeps orchestration, and this module
 * holds the mapping.
 */

import { isEmpty, isNil, isPlainObject, isString } from 'lodash-es';
import { z } from 'zod';
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

const ResponsesMessageItemSchema = z.object({
  type: z.literal('message'),
  role: z.string().default('user'),
  content: z.unknown().optional(),
});

const ResponsesFunctionCallItemSchema = z.object({
  type: z.literal('function_call'),
  call_id: z.string().optional(),
  id: z.string().optional(),
  name: z.string().optional(),
  arguments: z.unknown().optional(),
});

const ResponsesLocalShellCallItemSchema = z.object({
  type: z.literal('local_shell_call'),
  call_id: z.string().optional(),
  id: z.string().optional(),
  action: z
    .object({
      exec: z
        .object({
          command: z.string().optional(),
        })
        .optional(),
    })
    .optional(),
});

const ResponsesWebSearchCallItemSchema = z.object({
  type: z.literal('web_search_call'),
  call_id: z.string().optional(),
  id: z.string().optional(),
  action: z
    .object({
      query: z.string().optional(),
    })
    .optional(),
});

const ResponsesCustomToolCallItemSchema = z.object({
  type: z.literal('custom_tool_call'),
  call_id: z.string().optional(),
  id: z.string().optional(),
  name: z.string().optional(),
  input: z.string().optional(),
  status: z.string().optional(),
});

const ResponsesToolOutputItemSchema = z.object({
  type: z.enum(['function_call_output', 'custom_tool_call_output']),
  call_id: z.string().optional(),
  id: z.string().optional(),
  output: z.unknown().optional(),
});

const ResponsesInputItemSchema = z.preprocess(
  (value) => {
    if (!isPlainObject(value)) {
      return value;
    }

    const candidate = value as { role?: unknown; type?: unknown } & object;
    if ((!isString(candidate.type) || candidate.type.length === 0) && isString(candidate.role)) {
      return Object.assign({}, candidate, { type: 'message' as const });
    }
    return value;
  },
  z.discriminatedUnion('type', [
    ResponsesMessageItemSchema,
    ResponsesFunctionCallItemSchema,
    ResponsesLocalShellCallItemSchema,
    ResponsesWebSearchCallItemSchema,
    ResponsesCustomToolCallItemSchema,
    ResponsesToolOutputItemSchema,
  ]),
);

export type ResponsesInputItem = z.infer<typeof ResponsesInputItemSchema>;
type ResponsesToolCallItem = Exclude<
  ResponsesInputItem,
  z.infer<typeof ResponsesMessageItemSchema> | z.infer<typeof ResponsesToolOutputItemSchema>
>;

function parseResponsesInputItems(input: unknown[]): ResponsesInputItem[] {
  return input.flatMap((item) => {
    const parsed = parseResponsesInputItem(item);
    return parsed ? [parsed] : [];
  });
}

export function parseResponsesInputItem(input: unknown): ResponsesInputItem | null {
  const parsed = ResponsesInputItemSchema.safeParse(input);
  return parsed.success ? parsed.data : null;
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
  const inputItems = Array.isArray(body.input) ? parseResponsesInputItems(body.input) : null;

  if (inputItems) {
    for (const item of inputItems) {
      if (
        item.type === 'function_call' ||
        item.type === 'local_shell_call' ||
        item.type === 'web_search_call' ||
        item.type === 'custom_tool_call'
      ) {
        const callId = item.call_id ?? item.id ?? `call_${Date.now()}`;
        if (item.type === 'custom_tool_call' && item.status?.toLowerCase() === 'incomplete') {
          incompleteCustomCallIds.add(callId);
          continue;
        }

        const toolName =
          item.type === 'local_shell_call'
            ? 'shell'
            : item.type === 'web_search_call'
              ? 'builtin_web_search'
              : (item.name ?? 'unknown');
        callIdToToolName.set(callId, toolName);
      }
    }

    for (const item of inputItems) {
      if (item.type === 'message') {
        const content = normalizeResponsesMessageContent(item.content);
        messages.push({ role: item.role, content });
        continue;
      }

      if (
        item.type === 'function_call' ||
        item.type === 'local_shell_call' ||
        item.type === 'web_search_call' ||
        item.type === 'custom_tool_call'
      ) {
        const callId = item.call_id ?? item.id ?? `call_${Date.now()}`;
        if (incompleteCustomCallIds.has(callId)) {
          continue;
        }

        const toolName = callIdToToolName.get(callId) ?? 'unknown';
        const customInput = item.type === 'custom_tool_call' ? (item.input ?? '') : undefined;
        const args =
          customInput === undefined
            ? resolveToolArguments(item)
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

      if (item.type === 'function_call_output' || item.type === 'custom_tool_call_output') {
        const callId = item.call_id ?? item.id ?? 'unknown';
        if (incompleteCustomCallIds.has(callId)) {
          continue;
        }
        if (item.type === 'custom_tool_call_output' && !callIdToToolName.has(callId)) {
          continue;
        }

        const toolName = callIdToToolName.get(callId) ?? 'unknown';
        const normalizedOutput = normalizeResponsesOutput(item.output);
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

  removeLeadingOrphanToolHistory(messages);
  rewriteTerminalAssistantPrefill(messages);

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

export function resolveToolArguments(item: ResponsesToolCallItem): Record<string, unknown> {
  if (item.type === 'local_shell_call') {
    const command = item.action?.exec?.command;
    return {
      command: command ? [command] : [],
    };
  }

  if (item.type === 'web_search_call') {
    return {
      query: item.action?.query ?? '',
    };
  }

  if (item.type === 'custom_tool_call') {
    return {};
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

function removeLeadingOrphanToolHistory(messages: OpenAIChatRequest['messages']): void {
  let firstConversationIndex = 0;
  while (messages[firstConversationIndex]?.role === 'system') {
    firstConversationIndex += 1;
  }

  let orphanHistoryEnd = firstConversationIndex;
  while (orphanHistoryEnd < messages.length) {
    const message = messages[orphanHistoryEnd];
    const isToolResult = message.role === 'tool' || message.role === 'function';
    const isToolCall = message.role === 'assistant' && (message.tool_calls?.length ?? 0) > 0;
    if (!isToolResult && !isToolCall) {
      break;
    }
    orphanHistoryEnd += 1;
  }

  if (orphanHistoryEnd > firstConversationIndex) {
    messages.splice(firstConversationIndex, orphanHistoryEnd - firstConversationIndex);
  }
}

function rewriteTerminalAssistantPrefill(messages: OpenAIChatRequest['messages']): void {
  const terminalMessage = messages.at(-1);
  if (
    terminalMessage?.role === 'assistant' &&
    isString(terminalMessage.content) &&
    terminalMessage.content.trim().length > 0 &&
    (terminalMessage.tool_calls?.length ?? 0) === 0
  ) {
    terminalMessage.role = 'user';
  }
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
