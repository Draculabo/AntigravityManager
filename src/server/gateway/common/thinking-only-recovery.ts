import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { Readable } from 'node:stream';
import { GenerationOutputState } from '../../../modules/proxy-gateway/antigravity/GenerationOutputState';
import {
  decodeInternalSseData,
  IncrementalSseDataParser,
  MAX_SSE_EVENT_BYTES,
} from '../../../modules/proxy-gateway/antigravity/internal-sse';
import {
  markTerminalGenerationFailure,
  UpstreamGenerationError,
} from '../../../modules/proxy-gateway/antigravity/UpstreamGenerationError';
import type { GeminiInternalRequest } from '../../../modules/proxy-gateway/antigravity/types';
import type { GeminiResponse, GeminiUsageMetadata } from './interfaces/request-interfaces';
import type { GenerationTransportSnapshot } from '../modules/gemini/gemini-client.service';
import type { UpstreamSessionRecoveryBudget } from './upstream-session-recovery';
import { awaitRequestOperation, throwIfRequestAborted } from './request-cancellation';
import { estimateRetainedJsonBytes } from './retained-json-size';
import { StreamOutputBudget } from './stream-output-budget';
import { IncrementalSseLines } from './incremental-sse-lines';
import { inheritGenerationDeadline } from './generation-deadline';

type Send<T> = (
  body: GeminiInternalRequest,
  timeoutMs: number,
  transport: GenerationTransportSnapshot,
  signal?: AbortSignal,
) => Promise<T>;

/** One continuation with the original request/transport snapshot and logical deadline. */
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
      const cue = { text: chinese ? '继续。' : 'Continue.' };
      const tail = this.request.request.contents.at(-1);
      if (tail?.role === 'user') {
        tail.parts.push(cue);
      } else {
        this.request.request.contents.push({ role: 'user', parts: [cue] });
      }
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

interface SseEvent {
  data: string | null;
  lines: string[];
}

async function* events(source: Readable): AsyncGenerator<SseEvent> {
  const decoder = new TextDecoder('utf8', { fatal: true });
  const lines = new IncrementalSseLines();
  const parser = new IncrementalSseDataParser();
  let frameLines: string[] = [];
  let frameBytes = 0;
  const takeFrame = (data: SseEvent['data']): SseEvent => {
    const frame = { data, lines: frameLines };
    frameLines = [];
    frameBytes = 0;
    return frame;
  };
  const decode = function* (text: string, newline = '\n') {
    for (const line of lines.push(text)) {
      const data = parser.pushLine(line);
      const separator = line === '' || line === '\r';
      if (data !== null && !separator) {
        // A new data line may dispatch the previous record when upstream omits its separator.
        yield takeFrame(data);
      }
      frameBytes += (line.length + newline.length) * 2 + 64;
      if (frameBytes > MAX_SSE_EVENT_BYTES * 2) {
        throw new UpstreamGenerationError('invalid_upstream_response');
      }
      frameLines.push(line + newline);
      if (separator) {
        yield takeFrame(data);
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
    yield* decode(decoder.decode());
    if (lines.estimatedRetainedBytes > 0) {
      yield* decode('\n', '');
    }
    const tail = parser.finish();
    if (frameLines.length > 0) {
      yield takeFrame(tail);
    }
  } finally {
    lines.clear();
    parser.clear();
  }
}

function missingEventSeparator(tail: string): string {
  if (tail.endsWith('\n\n') || tail.endsWith('\n\r\n')) {
    return '';
  }
  return tail.endsWith('\n') ? '\n' : '\n\n';
}

/** Edit the data field while preserving all other SSE lines in their original order. */
function rewriteEvent(event: SseEvent, data: string | null): string {
  let pendingData = data;
  const raw = event.lines
    .map((line) => {
      if (!line.startsWith('data:')) {
        return line;
      }
      if (pendingData === null) {
        return '';
      }
      const prefix = line.startsWith('data: ') ? 'data: ' : 'data:';
      const newline = line.endsWith('\r\n') ? '\r\n' : '\n';
      const replaced = prefix + pendingData + newline;
      pendingData = null;
      return replaced;
    })
    .join('');
  return data === null ? raw : raw + missingEventSeparator(raw);
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
  inheritGenerationDeadline(cancellation, signal);
  let active = readable(source);
  const output = Readable.from(
    (async function* () {
      let firstUsage: GeminiUsageMetadata | undefined;
      try {
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const state = new GenerationOutputState();
          let pending = false;
          let lastUsage: GeminiUsageMetadata | undefined;
          let wireTail = '';
          const forward = (frame: string): string => {
            wireTail = (wireTail + frame.slice(-3)).slice(-3);
            return frame;
          };
          for await (const event of events(active)) {
            throwIfRequestAborted(signal);
            if (event.data === null) {
              yield forward(event.lines.join(''));
              continue;
            }
            const decoded = decodeInternalSseData(event.data);
            if (decoded.kind === 'ignored') {
              yield forward(pending ? rewriteEvent(event, null) : event.lines.join(''));
              continue;
            }
            if (decoded.kind === 'invalid') {
              throw new UpstreamGenerationError('invalid_upstream_response');
            }
            if (decoded.kind === 'error') {
              yield event.lines.join('');
              return;
            }
            const response = decoded.response;
            const rewriteResponse = (replacement: GeminiResponse) =>
              rewriteEvent(
                event,
                JSON.stringify(decoded.wrapped ? { response: replacement } : replacement),
              );
            if (response.usageMetadata) {
              lastUsage = response.usageMetadata;
            }
            if (pending) {
              if (response.promptFeedback || response.candidates?.length) {
                throw new UpstreamGenerationError('invalid_upstream_response');
              }
              yield forward(rewriteEvent(event, null));
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
                yield forward(
                  rewriteResponse({
                    ...response,
                    usageMetadata: undefined,
                    candidates: response.candidates?.map(
                      ({ finishReason: _finish, ...candidate }) => candidate,
                    ),
                  }),
                );
                continue;
              }
              throw failure;
            }
            let usageMetadata = response.usageMetadata;
            if (attempt > 0) {
              usageMetadata = combineRecoveryUsage(firstUsage, usageMetadata);
            } else if (state.terminal) {
              usageMetadata = lastUsage;
            } else if (state.streamPhase !== 'output_started') {
              usageMetadata = undefined;
            }
            yield forward(
              usageMetadata === response.usageMetadata
                ? event.lines.join('')
                : rewriteResponse({ ...response, usageMetadata }),
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
          // An EOF metadata line may be unterminated. Finish it before the next physical stream.
          const separator = missingEventSeparator(wireTail);
          if (separator) {
            yield separator;
          }
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
