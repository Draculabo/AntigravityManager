import { HttpException } from '@nestjs/common';
import { logger } from '@/shared/logging/logger';
import { SchemaInputError } from '../antigravity/schema/SchemaConversion';
import type { SignatureScopeContext } from '../../../server/gateway/common/signature-session-scope';
import { resolveUpstreamErrorHttpStatus } from '../../../server/gateway/common/upstream-error-http-status';
import { auditJsonObject } from './audit-json-object';
import { resolveAuditSessionId } from './audit-session-identity';
import { getTrafficAuditRequestContext } from './traffic-audit-context';
import { resolveHttpOutcome } from './traffic-audit-http-metadata';
import { trafficAuditService, type AuditSseBodyWriter } from './traffic-audit.service';
import { extractAuditUsage, mergeAuditUsage } from './audit-usage';
import { detectAuditOutputModalities, mergeAuditOutputModalities } from './audit-output-modality';
import { IncrementalSseRedactor } from './incremental-sse-redactor';

/** One executing WebSocket message owns one parent and the existing physical-attempt context. */
export class ResponsesWebSocketAudit {
  private readonly context = getTrafficAuditRequestContext();
  private readonly writer: AuditSseBodyWriter | null;
  private readonly redactor = new IncrementalSseRedactor({
    onRawParsedEvent: (value) => this.observe(value),
  });
  private bytes = 0;
  private partial = false;
  private terminal = false;
  private failedResponse = false;
  private status = 200;
  private error: unknown;
  private completed = false;
  private modalities: ReturnType<typeof detectAuditOutputModalities> = null;

  constructor(payload: unknown, transport: SignatureScopeContext) {
    const context = this.context;
    if (context) {
      const request = {
        headers: transport.headers,
        url: transport.url ?? '/v1/responses',
        body: payload,
      };
      context.auditSessionId = resolveAuditSessionId(request);
      context.parent = trafficAuditService.startParent({
        headers: transport.headers,
        method: 'WS',
        operation: 'response.create',
        protocol: 'openai-responses',
        requestBody: payload,
        sessionId: context.auditSessionId,
        trafficClass: 'model',
        url: request.url,
      });
    }
    this.writer = trafficAuditService.beginParentSse(context?.parent ?? null);
  }

  record(sse: string): void {
    if (!this.context?.parent || this.completed) {
      return;
    }
    this.bytes += Buffer.byteLength(sse);
    for (const chunk of this.redactor.push(sse)) {
      if (this.writer && !this.writer.write(chunk)) {
        this.partial = true;
      }
    }
  }

  async finish(error?: unknown, cancelled = false): Promise<void> {
    if (this.completed) {
      return;
    }
    this.completed = true;
    const context = this.context;
    if (!context?.parent) {
      return;
    }
    const final = this.redactor.finish();
    for (const chunk of final.chunks) {
      if (this.writer && !this.writer.write(chunk)) {
        this.partial = true;
      }
    }
    const failure =
      error ??
      this.error ??
      (!this.terminal
        ? new Error('WebSocket stream ended without a terminal response')
        : undefined);
    const status = cancelled
      ? 499
      : error
        ? error instanceof HttpException
          ? error.getStatus()
          : error instanceof SchemaInputError
            ? 400
            : (resolveUpstreamErrorHttpStatus(error) ?? 500)
        : !this.terminal
          ? 502
          : this.status;
    const partial = this.partial || !this.terminal;
    const outcome = cancelled
      ? 'client_disconnected'
      : status === 408 || status === 504
        ? 'timeout'
        : this.failedResponse || (!this.terminal && !error)
          ? 'upstream_error'
          : resolveHttpOutcome(status, failure);
    let captureIncomplete = false;
    let captureTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      const capturing = this.writer?.finish({
        errorSummary: final.result.errorSummary,
        parseErrorOffset: final.result.parseErrorOffset,
        partial,
        rawBytes: this.bytes,
        terminalStatus: outcome,
      });
      if (capturing) {
        // Match HTTP audit completion: disk capture cannot retain a socket message indefinitely.
        await Promise.race([
          capturing,
          new Promise<void>((resolve) => {
            captureTimer = setTimeout(() => {
              captureIncomplete = true;
              resolve();
            }, 2_000);
          }),
        ]);
      }
    } catch (captureError) {
      captureIncomplete = true;
      logger.warn('WebSocket audit payload finalization failed', captureError);
    } finally {
      clearTimeout(captureTimer);
      trafficAuditService.completeParent(context.parent, {
        sessionId: context.auditSessionId,
        status,
        outcome,
        error: failure,
        partial: partial || captureIncomplete,
        responsePayloadHandled: true,
        usage: mergeAuditUsage(context.responseUsage, context.upstreamUsage),
        outputModalities: this.modalities,
      });
    }
  }

  private observe(value: unknown): void {
    const event = auditJsonObject(value);
    const response = auditJsonObject(event?.response);
    if (event?.type === 'response.completed' || event?.type === 'response.incomplete') {
      this.terminal = true;
      this.modalities = mergeAuditOutputModalities(
        this.modalities,
        detectAuditOutputModalities(response),
      );
      if (this.context) {
        this.context.responseUsage = mergeAuditUsage(
          this.context.responseUsage,
          extractAuditUsage(response),
        );
      }
    }
    if (event?.type === 'response.failed' || event?.type === 'error') {
      this.terminal = true;
      this.failedResponse = event.type === 'response.failed';
      this.error = response?.error ?? event.error;
      const code = auditJsonObject(this.error)?.code;
      this.status =
        code === 'upstream_timeout' || code === 'DEADLINE_EXCEEDED' || code === 'ETIMEDOUT'
          ? 504
          : (resolveUpstreamErrorHttpStatus(this.error) ?? 502);
    }
  }
}
