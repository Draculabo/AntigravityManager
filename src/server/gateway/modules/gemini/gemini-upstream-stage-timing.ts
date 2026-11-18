import type { ClientRequest } from 'node:http';
import { performance } from 'node:perf_hooks';
import { logger } from '@/shared/logging/logger';
import type { CurrentUpstreamAttemptHandle } from '@/modules/proxy-gateway/audit/traffic-audit-context';
import type { UpstreamAttemptTiming } from '@/modules/proxy-gateway/audit/upstream-attempt-timing';

/** Diagnostic observations for one admitted transport call, relative to its admission. */
export class GeminiUpstreamStageTiming {
  private readonly startedAt = performance.now();
  private uploadFinishedMs: number | null = null;
  private responseHeadersMs: number | null = null;
  private firstByteMs: number | null = null;
  private firstUsableOutputMs: number | null = null;
  private currentRequest: ClientRequest | undefined;

  constructor(private readonly attempt: CurrentUpstreamAttemptHandle) {}

  observeRequest = (request: ClientRequest): void => {
    // Axios can follow redirects for small bodies. Report stages for the final native exchange.
    this.currentRequest = request;
    this.uploadFinishedMs = null;
    this.responseHeadersMs = null;
    this.firstByteMs = null;
    this.firstUsableOutputMs = null;
    request.once('finish', () => {
      if (this.currentRequest === request) {
        this.uploadFinishedMs = this.elapsed();
      }
    });
    request.once('response', () => {
      if (this.currentRequest === request) {
        this.responseHeadersMs = this.elapsed();
      }
    });
  };

  observeUsableOutput(): void {
    this.firstUsableOutputMs ??= this.elapsed();
  }

  observeFirstByte(): void {
    this.firstByteMs ??= this.elapsed();
  }

  snapshot(): UpstreamAttemptTiming {
    return {
      version: 1,
      uploadFinishedMs: this.uploadFinishedMs,
      responseHeadersMs: this.responseHeadersMs,
      firstByteMs: this.firstByteMs,
      firstUsableOutputMs: this.firstUsableOutputMs,
    };
  }

  report(): void {
    this.currentRequest = undefined;
    logger.debug('Upstream generation stages', {
      requestId: this.attempt.requestId,
      attemptId: this.attempt.id,
      ...this.snapshot(),
    });
  }

  private elapsed(): number {
    return Math.round(performance.now() - this.startedAt);
  }
}
