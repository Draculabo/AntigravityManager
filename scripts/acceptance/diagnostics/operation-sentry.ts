import { createServer } from 'node:http';
import { gunzipSync } from 'node:zlib';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { processError } from '../../../src/modules/antigravity-runtime/processErrors';
import { classifyOperationCause } from '../../../src/modules/cloud-account/services/operation-cause';
import { OperationContext } from '../../../src/shared/observability/operationContext';
import {
  OperationReportSchema,
  type OperationDiagnostic,
  type OperationReport,
} from '../../../src/shared/observability/operationDiagnostic';
import { formatOperationDiagnostic } from '../../../src/shared/observability/operationDiagnosticText';
import { setErrorReportingEnabled } from '../../../src/shared/observability/errorReporting';
import { logger } from '../../../src/shared/logging/logger';
import { SwitchTraceRecorder } from '../../../src/modules/antigravity-runtime/switch/switchTrace';
import type { SwitchTrace } from '../../../src/shared/observability/switchDiagnostic';

interface AcceptanceSdk {
  setUser(value: { email: string; geo: { city: string } }): void;
  setTag(name: string, value: string): void;
  setContext(name: string, value: { value: string }): void;
  addBreadcrumb(value: { message: string }): void;
  flush(timeout: number): Promise<boolean>;
  close(timeout: number): Promise<boolean>;
}

/** Uses synthetic classifications and an isolated preference file; no account storage is opened. */
export async function verifyOperationReporting(
  initialize: () => Promise<void>,
  sdk: AcceptanceSdk,
  runtime: 'desktop-embedded' | 'standalone-core',
): Promise<void> {
  const directory = z.string().min(1).parse(process.env.AGM_DIAGNOSTIC_DIRECTORY);
  const live = process.env.AGM_DIAGNOSTIC_LIVE === 'true';
  const offline = process.env.AGM_DIAGNOSTIC_OFFLINE === 'true';
  const originalDsn = live
    ? new URL(z.string().url().parse(process.env.AGM_DIAGNOSTIC_LIVE_DSN))
    : null;
  let eventsReceived = 0;
  let privacyPassed = true;
  let remoteAccepted = false;
  const received = new Map<
    string,
    { eventId: string; report: OperationReport; level: 'error' | 'warning' }
  >();
  const receiver = createServer((request, response) => {
    const buffers: Buffer[] = [];
    let bytes = 0;
    request.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 256 * 1024) {
        request.destroy();
        return;
      }
      buffers.push(chunk);
    });
    request.on('end', () => {
      void (async () => {
        const body = Buffer.concat(buffers);
        const decoded =
          request.headers['content-encoding'] === 'gzip'
            ? gunzipSync(body, { maxOutputLength: 256 * 1024 })
            : body;
        const lines = decoded.toString('utf8').split('\n');
        const eventLines: string[] = [];
        for (let index = 1; index < lines.length - 1; index += 2) {
          const header = z.object({ type: z.string() }).parse(JSON.parse(lines[index]));
          if (header.type !== 'event') {
            continue;
          }
          const event = z
            .object({
              event_id: z.string().regex(/^[a-f0-9]{32}$/),
              level: z.enum(['error', 'warning']),
              release: z.literal(process.env.SENTRY_RELEASE),
              tags: z.object({
                diagnostic_id: z.uuid(),
                operation: OperationReportSchema.shape.failure.shape.operation,
                stage: OperationReportSchema.shape.failure.shape.stage,
                reason: OperationReportSchema.shape.failure.shape.reason,
                operation_runtime: z.literal(runtime),
              }),
              contexts: z.object({ operation_diagnostic: OperationReportSchema }),
              user: z.strictObject({ geo: z.strictObject({}) }),
            })
            .parse(JSON.parse(lines[index + 1]));
          eventsReceived += 1;
          eventLines.push(lines[index], lines[index + 1]);
          received.set(event.tags.diagnostic_id, {
            eventId: event.event_id,
            report: event.contexts.operation_diagnostic,
            level: event.level,
          });
          const raw: unknown = JSON.parse(lines[index + 1]);
          privacyPassed =
            privacyPassed &&
            !JSON.stringify(raw).includes('controlled-private') &&
            !['request', 'breadcrumbs', 'extra', 'server_name'].some(
              (key) => typeof raw === 'object' && raw !== null && key in raw,
            ) &&
            event.tags.operation === event.contexts.operation_diagnostic.failure.operation &&
            event.tags.stage === event.contexts.operation_diagnostic.failure.stage &&
            event.tags.reason === event.contexts.operation_diagnostic.failure.reason;
        }
        if (!privacyPassed) {
          response.writeHead(400).end('{}');
          return;
        }
        if (originalDsn && eventLines.length) {
          const project = originalDsn.pathname.split('/').filter(Boolean).at(-1);
          const endpoint = new URL(`/api/${project}/envelope/`, originalDsn.origin);
          endpoint.searchParams.set('sentry_key', originalDsn.username);
          endpoint.searchParams.set('sentry_version', '7');
          const header: unknown = JSON.parse(lines[0]);
          const envelopeHeader = z
            .object({
              event_id: z.string().optional(),
              sent_at: z.string().optional(),
              sdk: z.unknown().optional(),
            })
            .parse(header);
          const projectedHeader = JSON.stringify({
            ...envelopeHeader,
            dsn: originalDsn.toString(),
          });
          const accepted = await fetch(endpoint, {
            method: 'POST',
            headers: { 'content-type': 'application/x-sentry-envelope' },
            body: [projectedHeader, ...eventLines, ''].join('\n'),
            signal: AbortSignal.timeout(10_000),
          });
          remoteAccepted = accepted.ok;
          response.writeHead(accepted.status).end('{}');
          return;
        }
        response.writeHead(offline ? 503 : 200).end('{}');
      })().catch(() => {
        privacyPassed = false;
        response.writeHead(500).end('{}');
      });
    });
  });
  const port = z.coerce
    .number()
    .int()
    .min(1)
    .max(65535)
    .parse(process.env.AGM_DIAGNOSTIC_RECEIVER_PORT);
  await new Promise<void>((resolve) => receiver.listen(port, '127.0.0.1', resolve));
  const address = receiver.address();
  if (!address || typeof address === 'string') {
    throw new Error('Acceptance receiver has no port');
  }
  try {
    await initialize();
    sdk.setUser({
      email: 'controlled-private@example.invalid',
      geo: { city: 'controlled-private' },
    });
    sdk.setTag('account', 'controlled-private');
    sdk.setContext('private_context', { value: 'controlled-private' });
    sdk.addBreadcrumb({ message: 'controlled-private' });
    const context = new OperationContext('google-login');
    context.observe('token-exchange', 'started');
    await context.run(async () => {
      logger.error('controlled-private-lower-log');
    });
    const terminal = context.finish({
      stage: 'token-exchange',
      reason: 'http-rejected',
      upstreamStatus: 503,
      upstreamCode: 'temporarily_unavailable',
      accountCommit: 'not-attempted',
    });
    logger.error('Controlled forwarded diagnostic', { diagnostic: terminal });
    const terminals: OperationDiagnostic[] = [terminal];
    for (const error of [
      processError('probe-failed', processError('window-close-failed', undefined, 5)),
      processError('close-failed', processError('window-enumeration-failed', undefined, 5)),
      processError('close-failed', processError('no-closable-window')),
      processError('exit-unconfirmed', processError('probe-failed')),
      processError(
        'close-failed',
        processError('native-call-failed', new Error('controlled-private')),
      ),
      processError('close-failed', processError('system-directory-unavailable')),
    ]) {
      const classified = classifyOperationCause(error);
      const operation = new OperationContext('cloud-account-switch');
      operation.observe('process-close', 'started');
      const diagnostic = operation.finish({
        stage: 'process-close',
        ...classified.primary,
        reason: 'process-close-failed',
        target: 'classic',
        storage: 'credential-store',
        rollback: 'not-attempted',
        causes: classified.causes,
      });
      terminals.push(diagnostic);
      logger.error('Controlled forwarded diagnostic', { diagnostic });
    }
    const switchCases: { diagnostic: OperationDiagnostic; trace: SwitchTrace }[] = [];
    for (const recovered of [true, false]) {
      const operation = new OperationContext('cloud-account-switch');
      await operation.run(async () => {
        const recorder = new SwitchTraceRecorder();
        recorder.effects.credentials = 'confirmed';
        await recorder
          .phase(
            'service-replacement',
            'hot',
            async () => {
              throw processError('switched-hot-unconfirmed');
            },
            'restart',
          )
          .catch(() => {});
        await recorder.phase('restart-ownership', 'restart', async () => {});
        if (recovered) {
          for (const stage of [
            'client-close',
            'restart-write',
            'terms-restore',
            'client-start',
            'account-finalize',
          ] as const) {
            await recorder.phase(stage, 'restart', async () => {});
          }
        } else {
          await recorder
            .phase('client-close', 'restart', async () => {
              throw processError('exit-unconfirmed');
            })
            .catch(() => {});
        }
        const trace = recorder.finish(recovered ? 'recovered-by-restart' : 'failed');
        operation.setSwitchTrace(trace);
        if (recovered) {
          operation.completeSwitch();
        }
        const diagnostic = operation.finish({
          stage: 'process-close',
          reason: 'process-close-failed',
          target: 'classic',
        });
        terminals.push(diagnostic);
        switchCases.push({ diagnostic, trace });
        logger.error('Controlled forwarded diagnostic', { diagnostic });
      });
    }
    const flushed = await sdk.flush(15_000);
    const evidencePassed = terminals.every((diagnostic) => {
      const { reporting, ...failure } = diagnostic;
      const event = received.get(diagnostic.diagnosticId);
      const details = formatOperationDiagnostic(diagnostic);
      return (
        reporting.state === 'captured' &&
        event !== undefined &&
        reporting.eventId === event.eventId &&
        isDeepStrictEqual(event.report.failure, failure) &&
        details.includes(`Diagnostic ID: ${diagnostic.diagnosticId}`) &&
        details.includes(`Sentry event ID: ${reporting.eventId}`) &&
        (!diagnostic.process || details.includes(`Process failure: ${diagnostic.process.reason}`))
      );
    });
    const switchEvidencePassed = switchCases.every(({ diagnostic, trace }) => {
      const event = received.get(diagnostic.diagnosticId);
      return (
        event !== undefined &&
        isDeepStrictEqual(event.report.switchTrace, trace) &&
        event.level === (trace.outcome === 'recovered-by-restart' ? 'warning' : 'error')
      );
    });
    setErrorReportingEnabled(false);
    const disabled = new OperationContext('google-login').finish({
      stage: 'token-exchange',
      reason: 'network-failed',
      accountCommit: 'not-attempted',
    });
    const result = {
      runtime,
      live,
      offline,
      eventsReceived,
      privacyPassed,
      evidencePassed,
      switchEvidencePassed,
      processCases: terminals
        .slice(1)
        .filter((diagnostic) => !diagnostic.switchRecovery)
        .map((diagnostic) => ({
          diagnosticId: diagnostic.diagnosticId,
          process: diagnostic.process,
          reporting: diagnostic.reporting,
        })),
      remoteAccepted,
      flushed,
      diagnosticId: terminal.diagnosticId,
      reporting: terminal.reporting,
      release: process.env.SENTRY_RELEASE,
      disabledReceipt: disabled.reporting,
    };
    await writeFile(path.join(directory, `${runtime}.json`), JSON.stringify(result, null, 2));
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (
      eventsReceived !== terminals.length ||
      !privacyPassed ||
      !evidencePassed ||
      !switchEvidencePassed ||
      disabled.reporting.state !== 'not-reported' ||
      disabled.reporting.reason !== 'disabled' ||
      (live && !remoteAccepted) ||
      (!offline && !flushed)
    ) {
      throw new Error('Operation reporting acceptance failed');
    }
  } finally {
    await sdk.close(1000);
    receiver.closeAllConnections();
    await new Promise<void>((resolve) => receiver.close(() => resolve()));
  }
}
