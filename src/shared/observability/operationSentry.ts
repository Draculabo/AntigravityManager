import type { ErrorEvent } from '@sentry/node';
import { z } from 'zod';
import { OperationReportSchema, type OperationReport } from './operationDiagnostic';

const OsMetadataSchema = z.object({
  name: z.enum(['Windows', 'macOS', 'Mac OS X', 'Linux', 'Ubuntu']),
  version: z
    .string()
    .regex(/^\d+(?:\.\d+){0,3}(?:[-+]\d+)?$/)
    .optional(),
});
const RuntimeMetadataSchema = z.object({
  name: z.enum(['node', 'Node', 'Node.js', 'Electron']),
  version: z.string().regex(/^\d+(?:\.\d+){1,3}$/),
});
const ReleaseSchema = z
  .string()
  .max(128)
  .regex(/^antigravity-manager@\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/);
const TraceSchema = z.object({
  trace_id: z.string().regex(/^[a-f0-9]{32}$/),
  span_id: z.string().regex(/^[a-f0-9]{16}$/),
});

interface OperationScope {
  setTag(key: string, value: string): void;
  setContext(key: string, value: { serialized: string }): void;
  setFingerprint(value: string[]): void;
}

export function attachOperationScope(scope: OperationScope, report: OperationReport): Error {
  const { failure } = report;
  scope.setTag('operation_diagnostic_schema', '1');
  scope.setTag('diagnostic_id', failure.diagnosticId);
  scope.setTag('operation', failure.operation);
  scope.setTag('stage', failure.stage);
  scope.setTag('reason', failure.reason);
  // A string preserves the bounded structure through the SDK's default normalization depth.
  scope.setContext('operation_diagnostic', { serialized: JSON.stringify(report) });
  scope.setFingerprint([
    'operation-diagnostic-v1',
    failure.operation,
    failure.stage,
    failure.reason,
    failure.upstreamCode ?? failure.nativeCode ?? 'none',
  ]);
  const exception = new Error(`${failure.operation}: ${failure.stage}: ${failure.reason}`);
  exception.name = 'OperationFailure';
  // Source errors and their causes never enter SDK integrations or normalization.
  exception.stack = undefined;
  return exception;
}

/** Replace an operation event with its allowlisted content after SDK normalization. */
export function projectOperationSentryEvent(event: ErrorEvent): ErrorEvent | null {
  if (event.tags?.operation_diagnostic_schema !== '1') {
    return event;
  }
  const context = z
    .strictObject({ serialized: z.string().max(16 * 1024) })
    .safeParse(event.contexts?.operation_diagnostic);
  if (!context.success) {
    return null;
  }
  let value: unknown;
  try {
    value = JSON.parse(context.data.serialized);
  } catch {
    return null;
  }
  const parsed = OperationReportSchema.safeParse(value);
  if (!parsed.success) {
    return null;
  }
  const report = parsed.data;
  const { failure } = report;
  // Sentry derives the reserved runtime tag from its runtime context during ingestion.
  const runtime = event.tags.operation_runtime;
  const os = OsMetadataSchema.safeParse(event.contexts?.os);
  const runtimeMetadata = RuntimeMetadataSchema.safeParse(event.contexts?.runtime);
  const release = ReleaseSchema.safeParse(event.release);
  const trace = TraceSchema.safeParse(event.contexts?.trace);
  const projected: ErrorEvent = {
    type: undefined,
    event_id: event.event_id,
    timestamp: event.timestamp,
    platform: event.platform,
    ...(release.success ? { release: release.data } : {}),
    ...(['production', 'development', 'test', 'staging'].includes(event.environment ?? '')
      ? { environment: event.environment }
      : {}),
    level: 'error',
    user: { geo: {} },
    tags: {
      operation_diagnostic_schema: '1',
      diagnostic_id: failure.diagnosticId,
      operation: failure.operation,
      stage: failure.stage,
      reason: failure.reason,
      ...(runtime === 'desktop-embedded' || runtime === 'standalone-core'
        ? { runtime, operation_runtime: runtime }
        : {}),
    },
    contexts: {
      operation_diagnostic: report,
      ...(os.success ? { os: os.data } : {}),
      ...(runtimeMetadata.success ? { runtime: runtimeMetadata.data } : {}),
      ...(trace.success ? { trace: trace.data } : {}),
    },
    exception: {
      values: [
        {
          type: 'OperationFailure',
          value: `${failure.operation}: ${failure.stage}: ${failure.reason}`,
          ...(report.sourceLocations?.length
            ? {
                stacktrace: {
                  frames: report.sourceLocations.map((location) => ({ ...location, in_app: true })),
                },
              }
            : {}),
        },
      ],
    },
    fingerprint: [
      'operation-diagnostic-v1',
      failure.operation,
      failure.stage,
      failure.reason,
      failure.upstreamCode ?? failure.nativeCode ?? 'none',
    ],
  };
  // The fixed projection is normally below 4 KiB; omit step context if it exceeds the budget.
  if (new TextEncoder().encode(JSON.stringify(projected.contexts)).length > 16 * 1024) {
    projected.contexts = { operation_diagnostic: { failure, steps: [], stepsTruncated: true } };
  }
  return projected;
}
