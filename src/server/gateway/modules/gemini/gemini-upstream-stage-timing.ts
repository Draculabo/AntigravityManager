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
  private uploadedBodyBytes: number | undefined;
  private downloadedBodyBytes: number | undefined;
  private currentRequest: ClientRequest | undefined;

  constructor(
    private readonly attempt: CurrentUpstreamAttemptHandle,
    private readonly serializedBodyBytes?: number,
  ) {}

  observeRequest = (request: ClientRequest): void => {
    // Axios can follow redirects for small bodies. Report stages for the final native exchange.
    this.currentRequest = request;
    this.uploadFinishedMs = null;
    this.responseHeadersMs = null;
    this.firstByteMs = null;
    this.firstUsableOutputMs = null;
    this.uploadedBodyBytes = undefined;
    this.downloadedBodyBytes = undefined;
    request.once('finish', () => {
      if (this.currentRequest === request) {
        this.uploadFinishedMs = this.elapsed();
        this.uploadedBodyBytes = this.serializedBodyBytes;
        const length = request.getHeader('content-length');
        if (typeof length === 'number' || (typeof length === 'string' && /^\d+$/u.test(length))) {
          const bytes = Number(length);
          if (Number.isSafeInteger(bytes) && bytes >= 0) {
            this.uploadedBodyBytes = bytes;
          }
        }
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

  observeDownloadedBodyBytes(bytes: number): void {
    if (Number.isSafeInteger(bytes) && bytes >= 0) {
      this.downloadedBodyBytes = Math.max(bytes, this.downloadedBodyBytes ?? 0);
    }
  }

  snapshot(): UpstreamAttemptTiming {
    return {
      version: 1,
      uploadFinishedMs: this.uploadFinishedMs,
      responseHeadersMs: this.responseHeadersMs,
      firstByteMs: this.firstByteMs,
      firstUsableOutputMs: this.firstUsableOutputMs,
      ...(this.uploadedBodyBytes === undefined
        ? {}
        : { uploadedBodyBytes: this.uploadedBodyBytes }),
      ...(this.downloadedBodyBytes === undefined
        ? {}
        : { downloadedBodyBytes: this.downloadedBodyBytes }),
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
