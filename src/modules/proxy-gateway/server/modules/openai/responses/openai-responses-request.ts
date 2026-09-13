/**
 * Normalisation of the OpenAI Responses request shape into the chat request the gateway
 * already knows how to serve, plus the small guards it needs. Extracted from
 * `OpenAIOperations` with no behavior change: this cluster only referenced itself.
 *
 * Entry controllers keep the routes, `OpenAIOperations` keeps orchestration, and this module
 * holds the mapping.
 */

import { BadRequestException } from '@nestjs/common';
import { isEmpty, isNil, isPlainObject, isString } from 'lodash-es';
import { z } from 'zod';
import { resolveResponsesInputType } from './responses-input-type';
import { ApplyPatchFailureCompactor } from '@/modules/proxy-gateway/antigravity/ApplyPatchFailureCompaction';
import { toCustomToolArguments } from '@/modules/proxy-gateway/antigravity/CustomToolCall';
import {
  OpenAIChatRequest,
  OpenAIContentPart,
  OpenAITool,
  OpenAIToolCall,
} from '@/modules/proxy-gateway/server/common/interfaces/request-interfaces';
import { parseOpenAIInputAudio } from '../chat/openai-input-audio';
import { toResponsesOpenAIResponseFormat } from '../chat/openai-response-format';

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
  text?: { format?: unknown };
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
  role: z.preprocess((role) => (typeof role === 'string' ? role : 'user'), z.string()),
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

    if (resolveResponsesInputType(value) === 'message') {
      return Object.assign({}, value, { type: 'message' });
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

const JsonRecordSchema = z.record(z.string(), z.unknown());
const OpenAIToolSchema: z.ZodType<OpenAITool> = z.lazy(() =>
  z
    .object({
      type: z.string(),
      name: z.string().optional(),
      tools: z.array(OpenAIToolSchema).optional(),
      function: z
        .object({
          name: z.string(),
          description: z.string().optional(),
          parameters: JsonRecordSchema.optional(),
        })
        .optional(),
    })
    .catchall(z.unknown()),
);
const ResponsesToolChoiceSchema = z.union([
  z.string(),
  z.object({
    type: z.string(),
    function: z
      .object({
        name: z.string(),
      })
      .optional(),
  }),
]);
const ResponsesRequestBodySchema = z
  .object({
    model: z.string().optional(),
    instructions: z.string().optional(),
    input: z.unknown().optional(),
    metadata: JsonRecordSchema.optional(),
    previous_response_id: z.string().optional(),
    store: z.boolean().optional(),
    tools: z.array(OpenAIToolSchema).optional(),
    max_output_tokens: z.number().optional(),
    temperature: z.number().optional(),
    top_p: z.number().optional(),
    presence_penalty: z.number().optional(),
    frequency_penalty: z.number().optional(),
    seed: z.number().optional(),
    tool_choice: ResponsesToolChoiceSchema.optional(),
    stream: z.boolean().optional(),
    user: z.string().optional(),
    text: z
      .object({
        format: z.unknown().optional(),
      })
      .optional(),
  })
  .passthrough();
const ResponsesCompletedEventSchema = z.object({
  type: z.literal('response.completed'),
  response: z.unknown().optional(),
});
const ResponsesContentStringSchema = z.object({
  content: z.string().optional(),
});
const ResponsesMessageContentBlockSchema = z.object({
  type: z.string().optional(),
  text: z.string().optional(),
  image_url: z.unknown().optional(),
  input_audio: z.unknown().optional(),
  audio_url: z.unknown().optional(),
});
const ResponsesInputAudioSchema = z.object({
  data: z.string(),
  format: z.string().optional(),
});
const ResponsesAudioUrlSchema = z
  .object({
    url: z.string().min(1),
    mime_type: z.string().optional(),
    mimeType: z.string().optional(),
    format: z.string().optional(),
  })
  .transform(({ url, mime_type, mimeType, format }) => ({
    url,
    mime_type: mime_type ?? mimeType ?? format,
  }));
const ResponsesOutputSchema = z.object({
  content: z.string().optional(),
});
const ResponsesInlineDataSchema = z.object({
  data: z.string().min(1),
  mimeType: z.string().optional().catch(undefined),
});
const ResponsesSessionResponseSchema = z
  .object({
    id: z.string().min(1),
    output: z.array(z.unknown()),
  })
  .passthrough();

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

/** Validates a Responses request transported outside the typed HTTP controller. */
export function parseResponsesRequestBody(value: unknown): ResponsesRequestBody | null {
  const parsed = ResponsesRequestBodySchema.safeParse(value);
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
    const parsed = ResponsesCompletedEventSchema.safeParse(
      JSON.parse(dataLine.slice('data:'.length).trimStart()),
    );
    return parsed.success ? (parsed.data.response ?? null) : null;
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
        const itemRecord = ResponsesContentStringSchema.safeParse(item);
        const content = itemRecord.success ? itemRecord.data.content : undefined;
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
        const normalizedOutput = normalizeResponsesToolOutput(item.output);
        const outputText =
          toolName === 'apply_patch'
            ? applyPatchFailureCompactor.compact(normalizedOutput.text)
            : normalizedOutput.text;
        messages.push({
          role: 'tool',
          tool_call_id: callId,
          name: toolName,
          content: buildResponsesToolOutputContent(outputText, normalizedOutput.mediaParts),
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
    response_format: toResponsesOpenAIResponseFormat(body.text?.format),
    stream: body.stream,
    extra: {
      ...(body.metadata ?? {}),
      previous_response_id: body.previous_response_id,
      user_id: body.user,
    },
  };
}

const ResponsesImageUrlSchema = z
  .object({
    url: z.string().min(1),
    detail: z.enum(['auto', 'low', 'high']).optional(),
  })
  .catchall(z.json());

export function normalizeResponsesMessageContent(content: unknown): string | OpenAIContentPart[] {
  if (isString(content)) {
    return content;
  }
  const { mediaParts, textParts } = partitionResponsesContent(content);

  if (mediaParts.length === 0) {
    return textParts.join('\n');
  }

  const merged: OpenAIContentPart[] = [];
  const mergedText = textParts.join('\n');
  if (mergedText !== '') {
    merged.push({
      type: 'text',
      text: mergedText,
    });
  }
  merged.push(...mediaParts);
  return merged;
}

function partitionResponsesContent(content: unknown): {
  mediaParts: OpenAIContentPart[];
  textParts: string[];
  unhandledParts: unknown[];
} {
  const textParts: string[] = [];
  const mediaParts: OpenAIContentPart[] = [];
  const unhandledParts: unknown[] = [];
  const parts = Array.isArray(content) ? content : [content];

  for (const item of parts) {
    const parsedBlock = ResponsesMessageContentBlockSchema.safeParse(item);
    if (!parsedBlock.success) {
      unhandledParts.push(item);
      continue;
    }

    const block = parsedBlock.data;
    if (block.text !== undefined) {
      textParts.push(block.text);
      continue;
    }

    if (block.type === 'input_image' || block.type === 'image_url') {
      const imageUrl = ResponsesImageUrlSchema.safeParse(
        typeof block.image_url === 'string' ? { url: block.image_url } : block.image_url,
      );
      if (imageUrl.success) {
        mediaParts.push({ type: 'image_url', image_url: imageUrl.data });
      } else {
        unhandledParts.push(item);
      }
      continue;
    }

    if (block.type === 'input_audio' || block.type === 'audio') {
      const inputAudio = ResponsesInputAudioSchema.safeParse(block.input_audio);
      if (!inputAudio.success) {
        throw new BadRequestException(
          'Invalid input_audio: input_audio must be an object with string data and optional string format',
        );
      }
      const audioPart: OpenAIContentPart = {
        type: 'input_audio',
        input_audio: { data: inputAudio.data.data, format: inputAudio.data.format },
      };
      parseOpenAIInputAudio(audioPart);
      mediaParts.push(audioPart);
      continue;
    }

    if (block.type === 'audio_url') {
      const audioUrl = ResponsesAudioUrlSchema.safeParse(block.audio_url);
      if (audioUrl.success) {
        mediaParts.push({ type: 'audio_url', audio_url: audioUrl.data });
      } else {
        unhandledParts.push(item);
      }
      continue;
    }

    unhandledParts.push(item);
  }

  return { mediaParts, textParts, unhandledParts };
}

function normalizeResponsesToolOutput(output: unknown): {
  mediaParts: OpenAIContentPart[];
  text: string;
} {
  const outputRecord = isPlainObject(output) ? (output as Record<string, unknown>) : null;
  const content =
    outputRecord && Object.hasOwn(outputRecord, 'content') ? outputRecord.content : output;
  if (isString(content)) {
    return { mediaParts: [], text: content };
  }

  const typedContent =
    isPlainObject(content) && Object.hasOwn(content as Record<string, unknown>, 'type');
  if (Array.isArray(content) || typedContent) {
    const { mediaParts, textParts, unhandledParts } = partitionResponsesContent(content);
    if (textParts.length === 0 && mediaParts.length === 0) {
      const fallback = Array.isArray(content) ? unhandledParts : (unhandledParts[0] ?? null);
      return { mediaParts: [], text: JSON.stringify(fallback) };
    }
    return { mediaParts, text: textParts.join('\n') };
  }

  return {
    mediaParts: [],
    text: content === undefined ? '' : (JSON.stringify(content) ?? ''),
  };
}

function buildResponsesToolOutputContent(
  text: string,
  mediaParts: OpenAIContentPart[],
): string | OpenAIContentPart[] {
  if (mediaParts.length === 0) {
    return text;
  }
  return text === '' ? mediaParts : [{ type: 'text', text }, ...mediaParts];
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
      const parsedRecord = JsonRecordSchema.safeParse(parsed);
      if (parsedRecord.success) {
        return parsedRecord.data;
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

  const rawRecord = JsonRecordSchema.safeParse(raw);
  if (rawRecord.success) {
    return rawRecord.data;
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
  const outputRecord = ResponsesOutputSchema.safeParse(output);
  const content = outputRecord.success ? outputRecord.data.content : undefined;
  if (content) {
    return content;
  }
  if (isNil(output)) {
    return '';
  }
  return JSON.stringify(output);
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

  const inputRecord = ResponsesInlineDataSchema.safeParse(input);
  if (inputRecord.success) {
    return {
      mimeType: inputRecord.data.mimeType ?? defaultMimeType,
      data: inputRecord.data.data,
    };
  }

  return null;
}

export function parseResponsesSessionResponse(
  response: unknown,
): z.infer<typeof ResponsesSessionResponseSchema> | null {
  const parsed = ResponsesSessionResponseSchema.safeParse(response);
  return parsed.success ? parsed.data : null;
}
