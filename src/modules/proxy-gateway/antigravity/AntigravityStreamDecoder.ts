import { isPlainObject, isString } from 'lodash-es';
import type { AntigravityTokenUsage } from './AntigravityResponseDecoder';
import { getGeminiReasoningTokens } from './GeminiReasoningUsage';
import type { GenerationOutputState } from './GenerationOutputState';
import { decodeInternalSseData } from './internal-sse';
import { readThoughtSignature } from './signature-utils';
import type { Candidate, GeminiPart, GeminiResponse, UsageMetadata } from './types';

export interface GenerationStreamToolCall {
  name: string;
  id?: string;
  arguments: Record<string, unknown>;
  repeatKey?: string;
}

export interface GenerationStreamPart {
  text?: string;
  reasoning?: boolean;
  signature?: string;
  toolCall?: GenerationStreamToolCall;
  media?: { data?: string; mimeType?: string };
}

export interface GenerationStreamGrounding {
  queries?: string[];
  sources?: Array<{ title?: string; uri?: string }>;
}

interface GenerationStreamCandidate {
  index: number;
  parts: Iterable<GenerationStreamPart>;
  grounding: GenerationStreamGrounding | undefined;
  finishReason?: string;
}

export function decodeAntigravityStreamFrame(
  data: string,
  output: GenerationOutputState,
  inspectImage = false,
) {
  const decoded = decodeInternalSseData(data);
  if (decoded.kind !== 'response') {
    return decoded;
  }

  const { response } = decoded;
  output.observe(response);
  return {
    kind: 'response' as const,
    candidates: readCandidates(response.candidates ?? []),
    blocked: Boolean(response.promptFeedback?.blockReason && !response.candidates?.length),
    usage: decodeAntigravityStreamUsage(response.usageMetadata),
    hasImageData: inspectImage && responseHasInlineImageData(response),
  };
}

export function responseHasInlineImageData(response: GeminiResponse): boolean {
  return Boolean(
    response.candidates?.some((candidate) =>
      candidate.content?.parts?.some(
        (part) => isString(part.inlineData?.data) && part.inlineData.data.trim().length > 0,
      ),
    ),
  );
}

function* readCandidates(values: readonly Candidate[]): Generator<GenerationStreamCandidate, void> {
  for (const [index, candidate] of values.entries()) {
    yield {
      index,
      parts: readParts(candidate.content?.parts ?? []),
      get grounding() {
        return readGrounding(candidate.groundingMetadata);
      },
      finishReason: candidate.finishReason,
    };
  }
}

function* readParts(values: readonly GeminiPart[]): Generator<GenerationStreamPart, void> {
  for (const part of values) {
    const call = part.functionCall;
    const id = isString(call?.id) ? call.id : undefined;
    const data = part.inlineData;
    yield {
      text: part.text,
      reasoning: part.thought === true,
      signature: readThoughtSignature(
        isString(part.thoughtSignature)
          ? part.thoughtSignature
          : isString(part.thought_signature)
            ? part.thought_signature
            : undefined,
      ),
      toolCall: call
        ? {
            id,
            name: call.name,
            arguments: call.args ?? {},
            get repeatKey() {
              return id ? JSON.stringify(call) : undefined;
            },
          }
        : undefined,
      media: data
        ? {
            data: data.data,
            mimeType: isString(data.mimeType) ? data.mimeType : undefined,
          }
        : undefined,
    };
  }
}

function readGrounding(value: unknown): GenerationStreamGrounding | undefined {
  const grounding = readRecord(value);
  if (!grounding) {
    return undefined;
  }
  const queries = Array.isArray(grounding.webSearchQueries)
    ? grounding.webSearchQueries.filter(isString)
    : undefined;
  const sources = Array.isArray(grounding.groundingChunks)
    ? grounding.groundingChunks.flatMap((chunk) => {
        const web = readRecord(readRecord(chunk)?.web);
        if (!web) {
          return [];
        }
        return [
          {
            title: isString(web.title) ? web.title : undefined,
            uri: isString(web.uri) ? web.uri : undefined,
          },
        ];
      })
    : undefined;
  return queries?.length || sources?.length ? { queries, sources } : undefined;
}

export function decodeAntigravityStreamUsage(
  usage: UsageMetadata | undefined,
): AntigravityTokenUsage | undefined {
  if (!usage) {
    return undefined;
  }
  const reasoningTokens = getGeminiReasoningTokens(usage);
  // Legacy candidate counts include thought and tool tokens. Interactions reports them separately.
  const outputTokens =
    usage.total_output_tokens === undefined
      ? (usage.candidatesTokenCount ?? 0)
      : usage.total_output_tokens + reasoningTokens + (usage.total_tool_use_tokens ?? 0);
  return {
    inputTokens: usage.total_input_tokens ?? usage.promptTokenCount ?? 0,
    outputTokens,
    cachedInputTokens:
      usage.total_cached_tokens ?? usage.cachedContentTokenCount ?? usage.cachedTokens ?? 0,
    reasoningTokens,
    totalTokens: usage.total_tokens ?? usage.totalTokenCount,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return isPlainObject(value);
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}
