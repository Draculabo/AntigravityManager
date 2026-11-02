import { StringDecoder } from 'node:string_decoder';
import { z } from 'zod';

/**
 * Upper bound for one aggregated SSE response. The playground keeps the full
 * text in memory, so an upstream that never stops must not grow it without limit.
 */
export const PLAYGROUND_STREAM_MAX_BYTES = 8 * 1024 * 1024;

export class PlaygroundStreamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlaygroundStreamError';
  }
}

const StreamUsageSchema = z.object({
  prompt_tokens: z.number().int().nonnegative().optional(),
  completion_tokens: z.number().int().nonnegative().optional(),
  total_tokens: z.number().int().nonnegative().optional(),
});

const StreamDeltaSchema = z.object({
  content: z.string().nullable().optional(),
  reasoning_content: z.string().nullable().optional(),
  thinking: z.string().nullable().optional(),
});

const StreamChunkSchema = z.object({
  model: z.string().optional(),
  choices: z
    .array(
      z.object({
        delta: StreamDeltaSchema.optional(),
      }),
    )
    .optional(),
  usage: StreamUsageSchema.optional(),
  error: z
    .object({
      message: z.string().optional(),
    })
    .optional(),
});

export type PlaygroundStreamUsage = z.infer<typeof StreamUsageSchema>;

export interface PlaygroundStreamTimings {
  /** Request start to the terminal `[DONE]` event. */
  durationMs: number;
  /** Request start to the first non-empty reasoning delta. */
  firstReasoningDeltaMs?: number;
  /** Request start to the first non-empty visible text delta. */
  firstTextDeltaMs?: number;
  /** Request start to the last content delta. */
  lastDeltaMs?: number;
}

export interface PlaygroundStreamResult {
  model?: string;
  content: string;
  thinkingContent?: string;
  usage?: PlaygroundStreamUsage;
  timings: PlaygroundStreamTimings;
}

interface ReadStreamOptions {
  startedAt: number;
  now: () => number;
  maxBytes?: number;
}

/**
 * Aggregates an OpenAI-compatible chat completion SSE stream on one clock.
 *
 * A missing `[DONE]` marker is treated as a truncated response, not a success.
 * Timing fields stay undefined when their delta never arrived, so callers never
 * have to guess which clock a number belongs to.
 */
export async function readPlaygroundStream(
  source: AsyncIterable<unknown>,
  options: ReadStreamOptions,
): Promise<PlaygroundStreamResult> {
  const decoder = new StringDecoder('utf8');
  const maxBytes = options.maxBytes ?? PLAYGROUND_STREAM_MAX_BYTES;
  let buffer = '';
  let bytes = 0;
  let done = false;
  let content = '';
  let thinking = '';
  let model: string | undefined;
  let usage: PlaygroundStreamUsage | undefined;
  let firstReasoningDeltaMs: number | undefined;
  let firstTextDeltaMs: number | undefined;
  let lastDeltaMs: number | undefined;

  const consumeEvent = (block: string): void => {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n');
    if (!data) {
      return;
    }
    if (data === '[DONE]') {
      done = true;
      return;
    }

    let payload: unknown;
    try {
      payload = JSON.parse(data);
    } catch {
      throw new PlaygroundStreamError('Malformed completion stream event from API Proxy.');
    }
    const parsed = StreamChunkSchema.safeParse(payload);
    if (!parsed.success) {
      throw new PlaygroundStreamError('Malformed completion stream event from API Proxy.');
    }
    const chunk = parsed.data;
    if (chunk.error) {
      throw new PlaygroundStreamError(
        chunk.error.message?.trim() || 'API Proxy reported an error while streaming.',
      );
    }

    const eventAt = Math.max(0, Math.round(options.now() - options.startedAt));
    if (chunk.model) {
      model = chunk.model;
    }
    if (chunk.usage) {
      usage = chunk.usage;
    }

    for (const choice of chunk.choices ?? []) {
      const delta = choice.delta;
      if (!delta) {
        continue;
      }
      const reasoningDelta = delta.reasoning_content ?? delta.thinking;
      if (reasoningDelta) {
        firstReasoningDeltaMs ??= eventAt;
        thinking += reasoningDelta;
        lastDeltaMs = eventAt;
      }
      if (delta.content) {
        firstTextDeltaMs ??= eventAt;
        content += delta.content;
        lastDeltaMs = eventAt;
      }
    }
  };

  for await (const chunk of source) {
    if (typeof chunk === 'string') {
      bytes += Buffer.byteLength(chunk);
      buffer += chunk;
    } else if (chunk instanceof Uint8Array) {
      bytes += chunk.byteLength;
      buffer += decoder.write(Buffer.from(chunk));
    } else {
      throw new PlaygroundStreamError('Unsupported completion stream chunk from API Proxy.');
    }
    if (bytes > maxBytes) {
      throw new PlaygroundStreamError(
        'The completion stream exceeded the playground response limit.',
      );
    }

    let boundary = /\r?\n\r?\n/.exec(buffer);
    while (boundary) {
      const block = buffer.slice(0, boundary.index);
      buffer = buffer.slice(boundary.index + boundary[0].length);
      consumeEvent(block);
      if (done) {
        break;
      }
      boundary = /\r?\n\r?\n/.exec(buffer);
    }
    if (done) {
      break;
    }
  }

  if (!done && buffer.trim()) {
    consumeEvent(buffer);
  }
  if (!done) {
    throw new PlaygroundStreamError(
      'The completion stream ended before the API Proxy finished the response.',
    );
  }

  return {
    model,
    content,
    thinkingContent: thinking || undefined,
    usage,
    timings: {
      durationMs: Math.max(0, Math.round(options.now() - options.startedAt)),
      firstReasoningDeltaMs,
      firstTextDeltaMs,
      lastDeltaMs,
    },
  };
}
