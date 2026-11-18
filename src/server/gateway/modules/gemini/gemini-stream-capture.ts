import { Readable, Transform } from 'node:stream';
import { IncrementalSseRedactor } from '@/modules/proxy-gateway/audit/incremental-sse-redactor';
import {
  completeCurrentUpstreamAttempt,
  captureUpstreamAttemptUsage,
  type CurrentUpstreamAttemptHandle,
} from '@/modules/proxy-gateway/audit/traffic-audit-context';
import { trafficAuditService } from '@/modules/proxy-gateway/audit/traffic-audit.service';
import { toolCallGenerationDiagnostic } from '@/modules/proxy-gateway/audit/tool-call-generation-diagnostic';
import { thoughtStoreService } from '@/modules/proxy-gateway/thought-store/thought-store.service';
import {
  getCurrentProxyTimingState,
  markProxyUpstreamFirstByte,
} from '../../common/proxy-response-timing';
import { findUpstreamThoughtSignatureConflict } from '../../common/upstream-thought-signature-validation';
import { decodeInternalGeminiPayload } from '../../../../modules/proxy-gateway/antigravity/internal-sse';
import { GenerationOutputState } from '../../../../modules/proxy-gateway/antigravity/GenerationOutputState';
import { UpstreamGenerationError } from '../../../../modules/proxy-gateway/antigravity/UpstreamGenerationError';
import { upstreamGenerationFailure } from '../../common/upstream-generation-failure';
import { GenerationDeadlineExceededError } from '../../common/exceptions/generation-deadline.exception';
import { observeGenerationStreamProgress } from '../../common/generation-deadline';
import type { GeminiUpstreamStageTiming } from './gemini-upstream-stage-timing';

/** Own the upstream stream until validated frames are released or the consumer closes. */
export function captureGeminiStreamResult(
  source: Readable,
  input: {
    attempt: CurrentUpstreamAttemptHandle | null;
    model?: string;
    responseHeaders: Record<string, unknown> | undefined;
    status: number;
    outcome: 'completed' | 'auth_failed' | 'upstream_error';
    validateSignatures?: boolean;
    signal?: AbortSignal;
    stages?: GeminiUpstreamStageTiming;
  },
): Readable {
  let sourceEnded = false;
  source.once('end', () => {
    sourceEnded = true;
  });
  const thoughtCapture = input.model
    ? thoughtStoreService.beginStreamCapture(
        thoughtStoreService.getCurrentSessionKey(),
        input.model,
        thoughtStoreService.getCurrentCaptureLease(),
      )
    : undefined;
  let toolCallWarning: string | undefined;
  let signatureConflict: Error | null = null;
  let generationFailure: Error | undefined;
  const generation = new GenerationOutputState();
  const validatedFrames: Array<readonly string[]> = [];
  const auditRedactor = new IncrementalSseRedactor({
    onRawParsedEvent: (event) => {
      captureUpstreamAttemptUsage(input.attempt, event);
      if (signatureConflict || generationFailure) {
        return;
      }
      if (input.validateSignatures) {
        signatureConflict ??= findUpstreamThoughtSignatureConflict(event);
        if (signatureConflict) {
          return;
        }
        const decoded = decodeInternalGeminiPayload(event);
        if (decoded.kind === 'error') {
          generationFailure ??= upstreamGenerationFailure(decoded.error);
        } else if (decoded.kind === 'invalid') {
          generationFailure ??= new UpstreamGenerationError('invalid_upstream_response');
        } else if (decoded.kind === 'response') {
          generation.observe(decoded.response);
          const activeParts = decoded.response.candidates?.[0]?.content?.parts;
          if (
            activeParts?.some(
              (part) =>
                Boolean(part.text?.trim()) ||
                Boolean(part.functionCall) ||
                Boolean(part.inlineData?.data),
            )
          ) {
            observeGenerationStreamProgress(input.signal, generation.streamPhase);
          }
          if (generation.streamPhase === 'output_started') {
            input.stages?.observeUsableOutput();
          }
        }
      }
      if (!signatureConflict && !generationFailure) {
        thoughtCapture?.observe(event);
      }
    },
    onRawFrame: input.validateSignatures
      ? (frame) => {
          if (frame === null) {
            signatureConflict ??= new Error(
              'Upstream SSE event exceeds signature validation budget.',
            );
          } else if (!signatureConflict) {
            validatedFrames.push(frame);
          }
        }
      : undefined,
    onParsedEvent: (event) => {
      toolCallWarning ??= toolCallGenerationDiagnostic(event);
    },
  });
  const auditWriter = trafficAuditService.beginAttemptSse(input.attempt?.audit ?? null);
  const timing = getCurrentProxyTimingState();
  let totalBytes = 0;
  let completed = false;
  let reachedTerminalEvent = false;
  const captureSanitizedEvent = (sanitized: string): boolean => {
    if (signatureConflict) {
      return true;
    }
    const accepted = auditWriter?.write(sanitized) ?? true;
    reachedTerminalEvent =
      reachedTerminalEvent ||
      sanitized.includes('[DONE]') ||
      sanitized.includes('"response.completed"') ||
      sanitized.includes('"message_stop"') ||
      sanitized.includes('"finishReason"');
    return accepted;
  };
  const complete = (
    outcome: 'auth_failed' | 'completed' | 'client_disconnected' | 'upstream_error',
    error?: unknown,
  ) => {
    if (completed) {
      return;
    }
    completed = true;
    if (input.signal?.reason instanceof GenerationDeadlineExceededError) {
      outcome = 'upstream_error';
      error = input.signal.reason;
    }
    const final = auditRedactor.finish();
    if (signatureConflict) {
      outcome = 'upstream_error';
      error = signatureConflict;
    } else if (input.validateSignatures && outcome === 'completed') {
      generationFailure ??= generation.failure();
      if (generationFailure) {
        outcome = 'upstream_error';
        error = generationFailure;
      }
    }
    let auditPartial =
      outcome !== 'completed' ||
      final.result.parseErrorOffset !== null ||
      final.result.errorSummary !== null;
    for (const sanitized of final.chunks) {
      if (!captureSanitizedEvent(sanitized)) {
        auditPartial = true;
      }
    }
    thoughtCapture?.finish(
      sourceEnded && outcome === 'completed' && !signatureConflict && !generationFailure,
    );
    auditWriter?.finish({
      errorSummary:
        signatureConflict?.message ??
        generationFailure?.message ??
        final.result.errorSummary ??
        toolCallWarning,
      parseErrorOffset: final.result.parseErrorOffset,
      partial: auditPartial,
      rawBytes: totalBytes,
      terminalStatus: outcome,
    });
    completeCurrentUpstreamAttempt(input.attempt, {
      timing: input.stages?.snapshot(),
      error: error ?? toolCallWarning,
      outcome,
      partial: auditPartial,
      responsePayloadHandled: Boolean(auditWriter),
      responseHeaders: input.responseHeaders,
      status: input.status,
    });
    input.stages?.report();
  };
  const transform = new Transform({
    transform(chunk: Buffer | string, _encoding, callback) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (buffer.byteLength > 0) {
        input.stages?.observeFirstByte();
        markProxyUpstreamFirstByte(timing);
      }
      totalBytes += buffer.byteLength;
      const sanitizedEvents = auditRedactor.push(buffer);
      if (signatureConflict) {
        complete('upstream_error', signatureConflict);
        callback(signatureConflict);
        return;
      }
      for (const sanitized of sanitizedEvents) {
        if (!captureSanitizedEvent(sanitized)) {
          // The audit writer owns its fail-open drop accounting.
        }
      }
      if (input.validateSignatures) {
        for (const frame of validatedFrames) {
          for (const segment of frame) {
            this.push(segment);
          }
        }
        validatedFrames.length = 0;
        callback();
      } else {
        callback(null, chunk);
      }
    },
    flush: (callback) => {
      complete(input.outcome);
      if (!signatureConflict) {
        for (const frame of validatedFrames) {
          for (const segment of frame) {
            transform.push(segment);
          }
        }
      }
      validatedFrames.length = 0;
      callback(signatureConflict);
    },
  });
  source.once('error', (error) => {
    complete('upstream_error', error);
    transform.destroy(error);
  });
  transform.once('close', () => {
    // The returned transform owns its source; unpipe alone leaves an HTTP stream alive.
    source.unpipe(transform);
    source.destroy();
    complete(
      reachedTerminalEvent || transform.writableFinished ? input.outcome : 'client_disconnected',
    );
    // Finishing the parser may stage a final frame even after the consumer has closed.
    validatedFrames.length = 0;
  });
  source.pipe(transform);
  return transform;
}
