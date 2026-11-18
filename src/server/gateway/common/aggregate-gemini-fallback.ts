import type { GeminiResponse } from './interfaces/request-interfaces';
import { decodeInternalGeminiPayload } from '../../../modules/proxy-gateway/antigravity/internal-sse';
import {
  markTerminalGenerationFailure,
  UpstreamGenerationError,
} from '../../../modules/proxy-gateway/antigravity/UpstreamGenerationError';
import { GenerationOutputState } from '../../../modules/proxy-gateway/antigravity/GenerationOutputState';
import { upstreamGenerationFailure } from './upstream-generation-failure';
import { combineRecoveryUsage } from './thinking-only-recovery';
import { aggregationAdmission } from './aggregation-admission';
import { awaitRequestOperation, throwIfRequestAborted } from './request-cancellation';
import { isIncompleteThinkingResponse } from './incomplete-thinking-response';
import type { GeminiInternalRequest } from '../../../modules/proxy-gateway/antigravity/types';
import { estimateRetainedJsonBytes } from './retained-json-size';

interface GenerationHooks {
  request: GeminiInternalRequest;
  generate: () => Promise<GeminiResponse>;
  start: () => Promise<NodeJS.ReadableStream>;
  collect: (stream: NodeJS.ReadableStream, signal?: AbortSignal) => Promise<GeminiResponse>;
  onFallback: () => void;
  recover?: () => Promise<GeminiResponse>;
  observeResponse?: (response: GeminiResponse) => void;
}

/** The discarded direct response leaves scope before a request can enter the shared queue. */
export async function generateGeminiWithAggregationFallback(
  hooks: GenerationHooks,
  signal?: AbortSignal,
): Promise<GeminiResponse> {
  try {
    throwIfRequestAborted(signal);
    {
      const decoded = decodeInternalGeminiPayload(await hooks.generate());
      if (decoded.kind === 'error') {
        throw upstreamGenerationFailure(decoded.error);
      }
      if (decoded.kind !== 'response') {
        throw new UpstreamGenerationError('invalid_upstream_response');
      }
      const direct = decoded.response;
      throwIfRequestAborted(signal);
      hooks.observeResponse?.(direct);
      if (direct.candidates?.[0]?.finishReason || direct.promptFeedback?.blockReason) {
        const state = new GenerationOutputState();
        state.observe(direct);
        const failure = state.failure();
        if (failure) {
          if (
            failure.code === 'empty_thinking_response' &&
            hooks.recover &&
            state.recoveryEligible
          ) {
            const recovered = decodeInternalGeminiPayload(await hooks.recover());
            if (recovered.kind === 'error') {
              throw markTerminalGenerationFailure(upstreamGenerationFailure(recovered.error));
            }
            if (recovered.kind !== 'response') {
              throw new UpstreamGenerationError('invalid_upstream_response');
            }
            const recoveredState = new GenerationOutputState();
            hooks.observeResponse?.(recovered.response);
            recoveredState.observe(recovered.response);
            const recoveredFailure = recoveredState.failure();
            if (recoveredFailure) {
              throw recoveredFailure;
            }
            return {
              ...recovered.response,
              usageMetadata: combineRecoveryUsage(
                direct.usageMetadata,
                recovered.response.usageMetadata,
              ),
            };
          }
          throw failure;
        }
        return direct;
      }
      const parts = direct.candidates?.[0]?.content?.parts;
      if (
        direct.promptFeedback?.blockReason ||
        (Array.isArray(parts) && parts.length > 0 && !isIncompleteThinkingResponse(direct))
      ) {
        throw new UpstreamGenerationError('incomplete_upstream_response');
      }
    }
    hooks.onFallback();
    const collected = await aggregateGeminiFallback(
      hooks.start,
      hooks.collect,
      signal,
      estimateRetainedJsonBytes(hooks.request),
    );
    hooks.observeResponse?.(collected);
    if (isIncompleteThinkingResponse(collected)) {
      throw new UpstreamGenerationError('incomplete_upstream_response');
    }
    return collected;
  } catch (error) {
    throwIfRequestAborted(signal);
    throw error;
  }
}

function destroy(stream: NodeJS.ReadableStream): void {
  if ('destroy' in stream && typeof stream.destroy === 'function') {
    stream.destroy();
  }
}

/** A cancelled unresolved provider operation keeps its credit until it actually settles. */
export async function aggregateGeminiFallback(
  start: () => Promise<NodeJS.ReadableStream>,
  collect: (stream: NodeJS.ReadableStream, signal?: AbortSignal) => Promise<GeminiResponse>,
  signal?: AbortSignal,
  requestBytes = 0,
): Promise<GeminiResponse> {
  const release = await aggregationAdmission.acquire(signal, requestBytes);
  let pending: Promise<NodeJS.ReadableStream> | undefined;
  let stream: NodeJS.ReadableStream | undefined;
  try {
    throwIfRequestAborted(signal);
    pending = start();
    void pending.then(
      (late) => {
        if (signal?.aborted && stream !== late) {
          destroy(late);
        }
      },
      () => {},
    );
    stream = await awaitRequestOperation(pending, signal);
    throwIfRequestAborted(signal);
    return await collect(stream, signal);
  } finally {
    if (stream && signal?.aborted) {
      destroy(stream);
    }
    if (!stream && pending && signal?.aborted) {
      // Releasing early would allow arbitrarily many uncooperative provider operations.
      void pending.then(release, release);
    } else {
      release();
    }
  }
}
