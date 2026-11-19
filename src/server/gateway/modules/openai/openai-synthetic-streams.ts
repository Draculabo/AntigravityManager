import { isString } from 'lodash-es';
import { v4 as uuidv4 } from 'uuid';
import type { Observable } from 'rxjs';
import { createLazySseStream } from '../../common/flow-controlled-sse-stream';
import type {
  OpenAIChatResponse,
  OpenAIChatRequest,
} from '../../common/interfaces/request-interfaces';
import { OpenAIResponsesStreamingMapper } from './responses/OpenAIResponsesStreamingMapper';
import { toOpenAIResponsesUsage } from '../../../../modules/proxy-gateway/antigravity/OpenAIUsageMapper';
import { qualifyNamespaceToolName } from '../../../../modules/proxy-gateway/antigravity/ToolNamespace';
import { parseOpenAIFunctionArguments } from './chat/openai-claude-conversion';
import {
  registerSerializedResponsesFrames,
  SerializedResponsesFrames,
} from './responses/serialized-responses-frames';
export function createSyntheticOpenAIStream(
  response: OpenAIChatResponse,
  includeUsage = false,
  usageAvailable = true,
  metaChunk?: string,
): Observable<string> {
  return createLazySseStream(function* () {
    const streamId = response.id || `chatcmpl-${uuidv4()}`;
    const created = response.created || Math.floor(Date.now() / 1000);
    const model = response.model;
    const choice = response.choices?.[0];
    const finishReason = choice?.finish_reason ?? 'stop';
    const reasoningContent = choice?.message?.reasoning_content;
    const content =
      choice?.message && isString(choice.message.content) ? choice.message.content : '';
    const chunkSize = 80;

    if (metaChunk) {
      yield metaChunk;
    }

    if (reasoningContent) {
      for (let index = 0; index < reasoningContent.length; index += chunkSize) {
        const chunk = {
          id: streamId,
          object: 'chat.completion.chunk',
          created,
          model,
          choices: [
            {
              index: 0,
              delta: {
                role: 'assistant',
                content: null,
                reasoning_content: reasoningContent.slice(index, index + chunkSize),
              },
              finish_reason: null,
            },
          ],
          ...(includeUsage ? { usage: null } : {}),
        };
        yield `data: ${JSON.stringify(chunk)}\n\n`;
      }
    }

    for (const [index, toolCall] of (choice?.message.tool_calls ?? []).entries()) {
      yield `data: ${JSON.stringify({
        id: streamId,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [
          {
            index: 0,
            delta: { role: 'assistant', tool_calls: [{ index, ...toolCall }] },
            finish_reason: null,
          },
        ],
        ...(includeUsage ? { usage: null } : {}),
      })}\n\n`;
    }

    const complete = function* (): Generator<string> {
      if (includeUsage && usageAvailable) {
        yield `data: ${JSON.stringify({
          id: streamId,
          object: 'chat.completion.chunk',
          created,
          model,
          choices: [],
          usage: response.usage,
        })}\n\n`;
      }
      yield 'data: [DONE]\n\n';
    };

    if (content.length === 0) {
      const finishChunk = {
        id: streamId,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: finishReason,
          },
        ],
        usage: includeUsage ? null : response.usage,
      };
      yield `data: ${JSON.stringify(finishChunk)}\n\n`;
      yield* complete();
      return;
    }

    for (let index = 0; index < content.length; index += chunkSize) {
      const piece = content.slice(index, index + chunkSize);
      const isLast = index + chunkSize >= content.length;
      const chunk = {
        id: streamId,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [
          {
            index: 0,
            delta: { content: piece },
            finish_reason: isLast ? finishReason : null,
          },
        ],
        usage: includeUsage
          ? null
          : isLast
            ? response.usage
            : { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      };
      yield `data: ${JSON.stringify(chunk)}\n\n`;
    }

    yield* complete();
  });
}

export function createSyntheticResponsesStream(
  response: OpenAIChatResponse,
  signatureSessionKey?: string,
  signatureMessageCount?: number,
  responseId?: string,
  clientTools?: OpenAIChatRequest['tools'],
): Observable<string> {
  const frames = new SerializedResponsesFrames();
  const stream = createLazySseStream(function* () {
    try {
      const mapper = new OpenAIResponsesStreamingMapper({
        onSerializedFrame: frames.capture,
        clientTools,
        model: response.model,
        responseId: responseId ?? `resp_${uuidv4()}`,
        signatureMessageCount,
        signatureSessionKey,
      });
      const choice = response.choices?.[0];
      const reasoningContent = choice?.message?.reasoning_content;
      const content =
        choice?.message && isString(choice.message.content) ? choice.message.content : undefined;

      yield mapper.createResponseCreatedEvent();
      yield mapper.createResponseInProgressEvent();
      mapper.setUsage(toOpenAIResponsesUsage(response.usage));
      if (reasoningContent) {
        for (const event of mapper.processPart({ text: reasoningContent, reasoning: true })) {
          yield event;
        }
      }
      if (content) {
        for (const event of mapper.processPart({ text: content })) {
          yield event;
        }
      }

      for (const toolCall of choice?.message?.tool_calls ?? []) {
        const custom = toolCall.type === 'custom' ? toolCall.custom : undefined;
        const functionName =
          custom?.name ??
          toolCall.function?.name ??
          (toolCall.operation || toolCall.type === 'apply_patch_call' ? 'apply_patch' : null);
        if (!functionName) {
          continue;
        }
        for (const event of mapper.processPart({
          toolCall: {
            arguments:
              (custom ? { input: custom.input } : toolCall.operation) ??
              parseOpenAIFunctionArguments(toolCall.function?.arguments ?? '{}'),
            id: toolCall.call_id || toolCall.id,
            name: qualifyNamespaceToolName(toolCall.namespace ?? '', functionName),
          },
        })) {
          yield event;
        }
      }

      for (const event of mapper.complete(choice?.finish_reason)) {
        yield event;
      }
    } finally {
      frames.clear();
    }
  });
  return registerSerializedResponsesFrames(stream, frames);
}
