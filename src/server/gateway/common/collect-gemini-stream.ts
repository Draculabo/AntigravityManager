import type { GeminiPart } from '../../../modules/proxy-gateway/antigravity/types';
import { decodeInternalSseData, IncrementalSseDataParser } from '../../../modules/proxy-gateway/antigravity/internal-sse';
import type { GeminiResponse } from './interfaces/request-interfaces';
import { clearImmediate, setImmediate } from 'node:timers';
import { performance } from 'node:perf_hooks';
import { AggregationInput } from './aggregation-input';
import { aggregationByteAccounting } from './aggregation-byte-accounting';
import { estimateParsedJsonBytes } from './retained-json-size';
import { upstreamGenerationFailure } from './upstream-generation-failure';
import { UpstreamGenerationError } from '../../../modules/proxy-gateway/antigravity/UpstreamGenerationError';
import { GenerationOutputState } from '../../../modules/proxy-gateway/antigravity/GenerationOutputState';

interface CollectionHooks {
  signal?: AbortSignal;
  createIdleTimer: (onTimeout: () => void) => { reset: () => void; clear: () => void };
  /** Pure predicate: parsed trees must remain free of aliases/cycles during accounting. */
  isPart: (value: unknown) => value is GeminiPart;
}

export class GeminiStreamCompletionError extends Error {
  constructor(message: 'Empty response stream' | 'Gemini stream ended without a finish reason') {
    super(message);
    this.name = 'GeminiStreamCompletionError';
  }
}

/** Owns collection listeners and transient decoding state until unary completion or failure. */
export function collectGeminiStream(
  upstream: NodeJS.ReadableStream,
  hooks: CollectionHooks,
): Promise<GeminiResponse> {
  return new Promise((resolve, reject) => {
    const input = new AggregationInput();
    const eventParser = new IncrementalSseDataParser();
    let receivedData = false;
    let settled = false;
    let ended = false;
    let scheduled: NodeJS.Immediate | undefined;
    let turnLines = 0;
    let turnBytes = 0;
    let turnWorkMs = 0;
    let parts: GeminiPart[] = [];
    let finishReason: string | undefined;
    let usageMetadata: GeminiResponse['usageMetadata'];
    let promptFeedback: GeminiResponse['promptFeedback'];
    const timer = hooks.createIdleTimer(() => fail(new Error('Stream idle timeout')));
    const account = aggregationByteAccounting.open();
    let partBytes = 64;
    let usageBytes = 0;
    let finishBytes = 0;
    account.set('partBytes', partBytes);

    function cleanup(): void {
      settled = true;
      timer.clear();
      if (scheduled) {
        clearImmediate(scheduled);
        scheduled = undefined;
      }
      input.clear();
      eventParser.clear();
      parts = [];
      usageMetadata = undefined;
      finishReason = undefined;
      account.close();
      upstream.removeListener('data', onData);
      upstream.removeListener('end', onEnd);
      upstream.removeListener('error', onError);
      upstream.removeListener('close', onClose);
      hooks.signal?.removeEventListener('abort', onAbort);
    }

    function fail(error: Error): void {
      if (settled) {
        return;
      }
      cleanup();
      reject(error);
      if ('destroy' in upstream && typeof upstream.destroy === 'function') {
        upstream.destroy();
      }
    }

    function consume(line: string): void {
      account.set(
        'unfinishedLineBytes',
        input.unfinishedLineBytes + eventParser.estimatedRetainedBytes,
      );
      const payload = eventParser.pushLine(line);
      account.set(
        'unfinishedLineBytes',
        input.unfinishedLineBytes + eventParser.estimatedRetainedBytes,
      );
      if (payload === null) {
        return;
      }
      consumePayload(payload);
    }

    function consumePayload(payload: string): void {
      // Joined, trimmed and sliced strings can coexist during decode. Charge references
      // conservatively without materializing any additional text for accounting.
      const lineBytes = payload.length * 6 + 96;
      const chunkBytes = input.transientBytes;
      account.set('transientBytes', chunkBytes + lineBytes);
      const decoded = decodeInternalSseData(payload);
      if (decoded.kind === 'ignored') {
        account.set('transientBytes', input.transientBytes);
        return;
      }
      if (decoded.kind === 'invalid') {
        throw new UpstreamGenerationError('invalid_upstream_response');
      }
      if (decoded.kind === 'error') {
        throw upstreamGenerationFailure(decoded.error);
      }
      timer.reset();
      try {
        account.set(
          'transientBytes',
          chunkBytes + lineBytes + estimateParsedJsonBytes(decoded.response),
        );
        const candidate = decoded.response.candidates?.[0];
        if (decoded.response.promptFeedback) {
          promptFeedback = decoded.response.promptFeedback;
        }
        if (Array.isArray(candidate?.content?.parts)) {
          for (const part of candidate.content.parts) {
            if (hooks.isPart(part)) {
              parts.push(part);
              partBytes += estimateParsedJsonBytes(part);
            }
          }
        }
        account.set('partBytes', partBytes);
        if (candidate?.finishReason) {
          finishReason = candidate.finishReason;
          finishBytes = estimateParsedJsonBytes(finishReason);
        }
        if (decoded.response.usageMetadata) {
          usageMetadata = decoded.response.usageMetadata;
          usageBytes = estimateParsedJsonBytes(usageMetadata);
        }
        account.set('metadataBytes', finishBytes + usageBytes);
      } finally {
        account.set('transientBytes', chunkBytes);
      }
    }

    function schedule(): void {
      scheduled = setImmediate(() => {
        scheduled = undefined;
        turnLines = 0;
        turnBytes = 0;
        turnWorkMs = 0;
        pump();
      });
    }

    function pump(): void {
      if (settled) {
        return;
      }
      const started = performance.now();
      const shouldYield = (): boolean =>
        turnLines >= 32 || turnBytes >= 64 * 1024 || turnWorkMs + performance.now() - started >= 4;
      try {
        while (!settled) {
          account.set('transientBytes', input.transientBytes);
          const step = input.next();
          turnBytes += step.decodedBytes;
          account.set(
            'unfinishedLineBytes',
            input.unfinishedLineBytes + eventParser.estimatedRetainedBytes,
          );
          account.set('transientBytes', input.transientBytes);
          if (step.kind === 'line') {
            consume(step.line);
            turnLines++;
          }
          if (step.kind === 'done') {
            if (ended) {
              finish();
            } else if (shouldYield()) {
              schedule();
            } else {
              upstream.resume();
            }
            return;
          }
          if (input.hasWork && shouldYield()) {
            schedule();
            return;
          }
        }
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      } finally {
        turnWorkMs += performance.now() - started;
        account.set(
          'unfinishedLineBytes',
          input.unfinishedLineBytes + eventParser.estimatedRetainedBytes,
        );
        account.set('transientBytes', input.transientBytes);
      }
    }

    function onData(chunk: Buffer): void {
      if (settled) {
        return;
      }
      try {
        upstream.pause();
        if (input.active || scheduled) {
          throw new Error('Upstream stream emitted data while aggregation was paused');
        }
        receivedData = true;
        input.accept(chunk);
        pump();
      } catch (error) {
        fail(
          error instanceof TypeError
            ? new Error('Gemini SSE stream contained invalid UTF-8')
            : error instanceof Error
              ? error
              : new Error(String(error)),
        );
      }
    }

    function finish(): void {
      try {
        for (const line of input.finish()) {
          consume(line);
        }
        const tail = eventParser.finish();
        if (tail !== null) {
          consumePayload(tail);
        }
      } catch (error) {
        fail(
          error instanceof TypeError
            ? new Error('Gemini SSE stream ended with an incomplete UTF-8 sequence')
            : error instanceof Error
              ? error
              : new Error(String(error)),
        );
        return;
      }
      if (!receivedData) {
        fail(new GeminiStreamCompletionError('Empty response stream'));
        return;
      }
      if (!finishReason && !promptFeedback?.blockReason) {
        fail(new GeminiStreamCompletionError('Gemini stream ended without a finish reason'));
        return;
      }
      const response: GeminiResponse = {
        candidates: [{ content: { role: 'model', parts }, finishReason }],
        usageMetadata,
        ...(promptFeedback ? { promptFeedback } : {}),
      };
      const state = new GenerationOutputState();
      state.observe(response);
      const failure = state.failure();
      if (failure) {
        fail(failure);
        return;
      }
      cleanup();
      resolve(response);
    }

    function onEnd(): void {
      if (settled) {
        return;
      }
      ended = true;
      if (!input.active) {
        finish();
      }
    }

    function onError(error: unknown): void {
      fail(error instanceof Error ? error : new Error(String(error)));
    }

    function onClose(): void {
      if (!ended) {
        fail(new Error('Upstream stream closed before completion'));
      }
    }

    function onAbort(): void {
      fail(new DOMException('Upstream request cancelled', 'AbortError'));
    }

    upstream.on('end', onEnd);
    upstream.on('error', onError);
    upstream.on('close', onClose);
    timer.reset();
    hooks.signal?.addEventListener('abort', onAbort, { once: true });
    if (hooks.signal?.aborted) {
      onAbort();
      return;
    }
    if ('destroyed' in upstream && upstream.destroyed === true) {
      onClose();
      return;
    }
    upstream.on('data', onData);
  });
}
