import { isString } from 'lodash-es';
import { errorProcessOwner } from '@/modules/error-diagnostics/public';
import { getTrafficAuditRequestContext } from '../../../../audit/traffic-audit-context';
import { classifyTransportError } from '../../../../antigravity/stream-error-utils';
import { OpenAIResponsesStreamingMapper } from '../../../../antigravity/OpenAIResponsesStreamingMapper';
import { readUpstreamErrorStatus } from '../../../common/upstream-error-codec';
import {
  decodeInternalSseData,
  describeInternalSseError,
  IncrementalSseDataParser,
} from '../../../../antigravity/internal-sse';
import {
  toOpenAIResponsesUsage,
  toOpenAIUsageFromGeminiUsageMetadata,
} from '../../../../antigravity/OpenAIUsageMapper';
import { createFrameControlledSseStream } from '../../../common/flow-controlled-sse-stream';
import { IncrementalSseLines } from '../../../common/incremental-sse-lines';
import {
  toGeminiUsageMetadata,
  toResponsesGroundingMetadata,
  toResponsesStreamPart,
  toUnknownRecord,
} from './openai-responses-adapters';
import {
  registerSerializedResponsesFrames,
  SerializedResponsesFrames,
} from './serialized-responses-frames';

import { publicProxyErrorMessage } from '../../../common/public-error-message';
import { GenerationOutputState } from '../../../../antigravity/GenerationOutputState';
import { UpstreamGenerationError } from '../../../../antigravity/UpstreamGenerationError';

interface ResponsesStreamHooks {
  requiresCleanImageEnd: boolean;
  inspectImage(data: string): { hasImageData: boolean; failed: boolean };
  markImageSuccess(): void;
  release(): void;
  logError(error: Error): void;
  createIdleTimer(onTimeout: () => void): { reset(): void; clear(): void };
}

/** Owns the suspended mapping iterator as well as the upstream Readable. */
export function createResponsesStream(
  upstream: NodeJS.ReadableStream,
  options: ConstructorParameters<typeof OpenAIResponsesStreamingMapper>[0],
  hooks: ResponsesStreamHooks,
) {
  const requestId = getTrafficAuditRequestContext()?.parent?.id;
  const frames = new SerializedResponsesFrames();
  const stream = createFrameControlledSseStream(upstream, (sink) => {
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const lines = new IncrementalSseLines();
    const eventParser = new IncrementalSseDataParser();
    const mapper = new OpenAIResponsesStreamingMapper({
      ...options,
      onSerializedFrame: frames.capture,
    });
    let completed = false;
    const outputState = new GenerationOutputState();
    let upstreamEnded = false;
    let sawImageData = false;
    let streamFailed = false;
    let pendingFinishReason: string | undefined;
    let released = false;
    const release = (): void => {
      if (!released) {
        released = true;
        hooks.release();
      }
    };
    let heartbeat: NodeJS.Timeout | undefined;
    const clearHeartbeat = (): void => {
      if (heartbeat) {
        clearInterval(heartbeat);
        heartbeat = undefined;
      }
    };
    const idle = hooks.createIdleTimer(() => {
      if (!completed) {
        fail('upstream_timeout', 'Upstream response stream timed out.', true);
      }
    });
    function complete(reason?: string): void {
      if (completed) {
        return;
      }
      completed = true;
      release();
      if (!hooks.requiresCleanImageEnd || sawImageData) {
        hooks.markImageSuccess();
      }
      clearHeartbeat();
      idle.clear();
      // Queue only the iterator. The current decoded event can leave scope before
      // full-text termination frames are serialized.
      sink.write(mapper.complete(reason));
      sink.end();
    }
    function fail(code: string, message: string, replace = false): void {
      if (completed) {
        return;
      }
      completed = true;
      streamFailed = true;
      release();
      clearHeartbeat();
      idle.clear();
      const publicMessage = publicProxyErrorMessage(message);
      if (replace) {
        sink.replace(mapper.fail(code, publicMessage));
      } else {
        sink.write(mapper.fail(code, publicMessage));
      }
      sink.end();
    }
    function captureDecodeError(error: unknown, functionName: 'mapChunk' | 'end'): void {
      if (error instanceof Error && classifyTransportError(error) === 'cancelled') {
        return;
      }
      try {
        errorProcessOwner.capture({
          error,
          source: 'proxy-gateway',
          module: 'openai-responses-stream',
          functionName,
          stage: 'stream-decoding',
          protocol: 'openai-responses',
          category: 'local_conversion',
          requestId,
        });
      } catch {
        // Diagnostic failure must preserve stream termination without recursive logging.
      }
    }
    function* mapChunk(chunk: Buffer): Generator<string> {
      if (completed) {
        return;
      }
      try {
        for (const line of lines.push(decoder.decode(chunk, { stream: true }))) {
          const data = eventParser.pushLine(line);
          if (data === null) {
            continue;
          }
          try {
            if (hooks.requiresCleanImageEnd) {
              const observation = hooks.inspectImage(data);
              sawImageData ||= observation.hasImageData;
              streamFailed ||= observation.failed;
            }
            const decoded = decodeInternalSseData(data);
            if (decoded.kind === 'error') {
              fail(
                readUpstreamErrorStatus({ error: decoded.error }) ?? 'upstream_error',
                describeInternalSseError(decoded.error),
              );
              return;
            }
            if (decoded.kind === 'invalid') {
              fail(
                'invalid_upstream_response',
                new UpstreamGenerationError('invalid_upstream_response').message,
              );
              return;
            }
            if (decoded.kind !== 'response') {
              continue;
            }
            idle.reset();
            const payload = decoded.response;
            outputState.observe(payload);
            const usage = toGeminiUsageMetadata(payload.usageMetadata);
            if (usage) {
              mapper.setUsage(toOpenAIResponsesUsage(toOpenAIUsageFromGeminiUsageMetadata(usage)));
            }
            if (payload.promptFeedback?.blockReason && !payload.candidates?.length) {
              complete('SAFETY');
              return;
            }
            if (!Array.isArray(payload.candidates)) {
              continue;
            }
            const candidate = toUnknownRecord(payload.candidates[0]);
            const content = toUnknownRecord(candidate?.content);
            if (Array.isArray(content?.parts)) {
              for (const part of content.parts) {
                const normalized = toResponsesStreamPart(part);
                if (normalized) {
                  for (const event of mapper.processPart(normalized)) {
                    yield event;
                  }
                }
              }
            }
            const grounding = toResponsesGroundingMetadata(candidate?.groundingMetadata);
            if (grounding) {
              for (const event of mapper.processGrounding(grounding)) {
                yield event;
              }
            }
            if (isString(candidate?.finishReason) && candidate.finishReason.length > 0) {
              const failure = outputState.failure();
              if (failure) {
                fail(failure.code, failure.message);
                return;
              }
              if (hooks.requiresCleanImageEnd) {
                pendingFinishReason = candidate.finishReason;
                continue;
              }
              complete(candidate.finishReason);
              return;
            }
          } catch (error) {
            streamFailed ||= hooks.requiresCleanImageEnd;
            if (!(error instanceof Error) || classifyTransportError(error) !== 'cancelled') {
              try {
                errorProcessOwner.capture({
                  error,
                  source: 'proxy-gateway',
                  module: 'openai-responses-stream',
                  functionName: 'mapChunk',
                  stage: 'stream-mapping',
                  protocol: 'openai-responses',
                  category: 'local_conversion',
                  requestId,
                });
              } catch {
                // Diagnostic failure must preserve per-event continuation without recursive logging.
              }
            }
            // Preserve the existing adapter policy for per-event mapping failures.
          }
        }
      } catch (error) {
        captureDecodeError(error, 'mapChunk');
        fail(
          'stream_decode_error',
          error instanceof TypeError
            ? 'Upstream response stream contained invalid UTF-8.'
            : error instanceof Error
              ? error.message
              : 'Invalid upstream SSE event.',
        );
      }
    }
    const data = (chunk: Buffer): void => sink.write(mapChunk(chunk));
    const end = (): void => {
      upstreamEnded = true;
      idle.clear();
      sink.write(
        (function* () {
          try {
            yield* mapChunk(Buffer.from(decoder.decode() + '\n\n'));
          } catch (error) {
            captureDecodeError(error, 'end');
            fail('stream_decode_error', 'Upstream response stream contained invalid UTF-8.');
            return;
          }
          if (completed) {
            return;
          }
          if (pendingFinishReason && !streamFailed) {
            complete(pendingFinishReason);
          } else {
            fail(
              'upstream_interrupted',
              'Upstream stream ended without output or a finish reason.',
            );
          }
        })(),
      );
    };
    const error = (cause: unknown): void => {
      if (completed) {
        return;
      }
      idle.clear();
      hooks.logError(cause instanceof Error ? cause : new Error(String(cause)));
      fail('upstream_stream_error', 'Upstream response stream failed.', true);
    };
    // The Readable can still report an already queued failure after cancellation.
    // Keep this terminal-aware listener until the source emits close.
    const closedError = (): void => {};
    const close = (): void => {
      // A normal Readable close can precede draining the final suspended mapping iterator.
      if (!completed && !upstreamEnded) {
        fail('upstream_interrupted', 'Upstream response stream closed before completion.');
      }
    };
    upstream.on('data', data);
    upstream.once('end', end);
    upstream.once('error', error);
    upstream.once('close', close);
    heartbeat = setInterval(() => {
      if (!completed && !stream.isPaused) {
        sink.write([': ping\n\n']);
      }
    }, 15_000);
    idle.reset();
    sink.write(
      (function* () {
        yield mapper.createResponseCreatedEvent();
        yield mapper.createResponseInProgressEvent();
      })(),
    );
    return () => {
      upstream.off('data', data);
      upstream.off('end', end);
      upstream.off('error', error);
      upstream.on('error', closedError);
      upstream.once('close', () => upstream.off('error', closedError));
      upstream.off('close', close);
      release();
      clearHeartbeat();
      lines.clear();
      eventParser.clear();
      frames.clear();
      idle.clear();
    };
  });
  return registerSerializedResponsesFrames(stream, frames);
}
