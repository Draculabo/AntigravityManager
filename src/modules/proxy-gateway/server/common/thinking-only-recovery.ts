import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { Readable } from 'node:stream';
import { GenerationOutputState } from '../../antigravity/GenerationOutputState';
import { decodeInternalSseData, IncrementalSseDataParser } from '../../antigravity/internal-sse';
import {
  markTerminalGenerationFailure,
  UpstreamGenerationError,
} from '../../antigravity/UpstreamGenerationError';
import type { GeminiInternalRequest } from '../../antigravity/types';
import type { GeminiResponse, GeminiUsageMetadata } from './interfaces/request-interfaces';
import type { GenerationTransportSnapshot } from '../modules/gemini/gemini-client.service';
import type { UpstreamSessionRecoveryBudget } from './upstream-session-recovery';
import { awaitRequestOperation, throwIfRequestAborted } from './request-cancellation';
import { estimateRetainedJsonBytes } from './retained-json-size';
import { StreamOutputBudget } from './stream-output-budget';
import { IncrementalSseLines } from './incremental-sse-lines';

type Send<T> = (
  body: GeminiInternalRequest,
  timeoutMs: number,
  transport: GenerationTransportSnapshot,
  signal?: AbortSignal,
) => Promise<T>;

/** One opt-in continuation with the original request/transport snapshot and logical deadline. */
export class ThinkingOnlyRecovery {
  private readonly memory = new StreamOutputBudget(128 * 1024 * 1024);
  private readonly request: GeminiInternalRequest;
  private inFlight = false;
  private closing = false;

  constructor(
    request: GeminiInternalRequest,
    private readonly budget: UpstreamSessionRecoveryBudget,
    private readonly transport: { current?: GenerationTransportSnapshot },
  ) {
    if (!this.memory.reserve(estimateRetainedJsonBytes(request))) {
      throw new UpstreamGenerationError('empty_thinking_response');
    }
    try {
      this.request = structuredClone(request);
    } catch (error) {
      this.memory.clear();
      throw error;
    }
  }

  async invoke<T>(send: Send<T>, signal?: AbortSignal): Promise<T> {
    try {
      throwIfRequestAborted(signal);
      const timeoutMs = Math.floor((this.budget.deadlineAt ?? 0) - performance.now());
      if (this.budget.thinkingOnlyAttempted || timeoutMs <= 0 || !this.transport.current) {
        throw new UpstreamGenerationError('empty_thinking_response');
      }
      this.budget.thinkingOnlyAttempted = true;
      this.request.requestId = `agent/${Date.now()}/${randomUUID()}`;
      const lastUser = this.request.request.contents.findLast((content) => content.role === 'user');
      const chinese = lastUser?.parts.some(
        (part) => typeof part.text === 'string' && /\p{Script=Han}/u.test(part.text),
      );
      this.request.request.contents.push({
        role: 'user',
        parts: [{ text: chinese ? '继续。' : 'Continue.' }],
      });
      this.inFlight = true;
      return await send(this.request, timeoutMs, this.transport.current, signal);
    } catch (error) {
      throw markTerminalGenerationFailure(error);
    } finally {
      this.inFlight = false;
      if (this.closing) {
        this.memory.clear();
      }
    }
  }

  close(): void {
    this.closing = true;
    if (!this.inFlight) {
      this.memory.clear();
    }
  }
}

/** Cumulative snapshots are added once across attempts; an unknown operand stays unknown. */
export function combineRecoveryUsage(
  first?: GeminiUsageMetadata,
  second?: GeminiUsageMetadata,
): GeminiUsageMetadata | undefined {
  if (!first || !second) {
    return undefined;
  }
  const sum = (a?: number, b?: number): number | undefined =>
    a === undefined || b === undefined ? undefined : a + b;
  return {
    promptTokenCount: sum(
      first.total_input_tokens ?? first.promptTokenCount,
      second.total_input_tokens ?? second.promptTokenCount,
    ),
    candidatesTokenCount: sum(
      first.total_output_tokens ?? first.candidatesTokenCount,
      second.total_output_tokens ?? second.candidatesTokenCount,
    ),
    totalTokenCount: sum(
      first.total_tokens ?? first.totalTokenCount,
      second.total_tokens ?? second.totalTokenCount,
    ),
    cachedContentTokenCount: sum(
      first.total_cached_tokens ?? first.cachedContentTokenCount ?? first.cachedTokens,
      second.total_cached_tokens ?? second.cachedContentTokenCount ?? second.cachedTokens,
    ),
    thoughtsTokenCount: sum(
      first.total_thought_tokens ?? first.totalThoughtTokens ?? first.thoughtsTokenCount,
      second.total_thought_tokens ?? second.totalThoughtTokens ?? second.thoughtsTokenCount,
    ),
  };
}

async function* events(source: Readable): AsyncGenerator<string> {
  const decoder = new TextDecoder('utf8', { fatal: true });
  const lines = new IncrementalSseLines();
  const parser = new IncrementalSseDataParser();
  const decode = function* (text: string) {
    for (const line of lines.push(text)) {
      const event = parser.pushLine(line);
      if (event !== null) {
        yield event;
      }
    }
  };
  try {
    for await (const chunk of source) {
      if (!Buffer.isBuffer(chunk) && typeof chunk !== 'string') {
        throw new UpstreamGenerationError('invalid_upstream_response');
      }
      yield* decode(typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true }));
    }
    yield* decode(decoder.decode() + '\n\n');
    const tail = parser.finish();
    if (tail !== null) {
      yield tail;
    }
  } finally {
    lines.clear();
    parser.clear();
  }
}

function readable(source: NodeJS.ReadableStream): Readable {
  return source instanceof Readable ? source : new Readable().wrap(source);
}

/** Hold only the eligible STOP until clean EOF; thought parts remain visible under backpressure. */
export function recoverThinkingOnlyStream(
  source: NodeJS.ReadableStream,
  recovery: ThinkingOnlyRecovery,
  send: Send<NodeJS.ReadableStream>,
  cancellation?: AbortSignal,
): Readable {
  const controller = new AbortController();
  const signal = cancellation
    ? AbortSignal.any([cancellation, controller.signal])
    : controller.signal;
  let active = readable(source);
  const frame = (response: GeminiResponse) => `data: ${JSON.stringify({ response })}\n\n`;
  const output = Readable.from(
    (async function* () {
      let firstUsage: GeminiUsageMetadata | undefined;
      try {
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const state = new GenerationOutputState();
          let pending = false;
          let lastUsage: GeminiUsageMetadata | undefined;
          for await (const event of events(active)) {
            throwIfRequestAborted(signal);
            const decoded = decodeInternalSseData(event);
            if (decoded.kind === 'ignored') {
              continue;
            }
            if (decoded.kind === 'invalid') {
              throw new UpstreamGenerationError('invalid_upstream_response');
            }
            if (decoded.kind === 'error') {
              yield `data: ${event}\n\n`;
              return;
            }
            const response = decoded.response;
            if (response.usageMetadata) {
              lastUsage = response.usageMetadata;
            }
            if (pending) {
              if (response.candidates?.some((candidate) => candidate.content?.parts?.length)) {
                throw new UpstreamGenerationError('invalid_upstream_response');
              }
              continue;
            }
            state.observe(response);
            const failure = state.terminal ? state.failure() : undefined;
            if (failure) {
              if (
                attempt === 0 &&
                failure.code === 'empty_thinking_response' &&
                state.recoveryEligible
              ) {
                pending = true;
                yield frame({
                  ...response,
                  usageMetadata: undefined,
                  candidates: response.candidates?.map(
                    ({ finishReason: _finish, ...candidate }) => candidate,
                  ),
                });
                continue;
              }
              throw failure;
            }
            yield frame(
              attempt === 0
                ? { ...response, usageMetadata: state.terminal ? lastUsage : undefined }
                : {
                    ...response,
                    usageMetadata: combineRecoveryUsage(firstUsage, response.usageMetadata),
                  },
            );
          }
          if (!pending) {
            return;
          }
          firstUsage = lastUsage;
          const pendingStream = recovery.invoke(send, signal);
          void pendingStream.then(
            (late) => {
              if (signal.aborted) {
                readable(late).destroy();
              }
            },
            () => undefined,
          );
          active = readable(await awaitRequestOperation(pendingStream, signal));
        }
      } finally {
        active.destroy();
        recovery.close();
      }
    })(),
    { objectMode: false, highWaterMark: 16 * 1024 },
  );
  const destroy = output._destroy.bind(output);
  output._destroy = (error, callback) => {
    controller.abort();
    active.destroy();
    recovery.close();
    destroy(error, callback);
  };
  const abort = () => output.destroy(new DOMException('Upstream request cancelled', 'AbortError'));
  signal.addEventListener('abort', abort, { once: true });
  output.once('close', () => signal.removeEventListener('abort', abort));
  if (signal.aborted) {
    abort();
  }
  return output;
}
