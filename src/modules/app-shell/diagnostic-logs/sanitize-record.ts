import { z } from 'zod';
import { parseCloudOperationDiagnostic } from '@/modules/cloud-account/diagnostics';
import { OperationStepRecordSchema } from '@/shared/observability/operationDiagnostic';

const ErrorCodeSchema = z.enum([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ENOENT',
  'EACCES',
  'EPERM',
  'EBUSY',
  'ENOSPC',
  'ERR_NETWORK',
  'ERR_BAD_REQUEST',
  'ERR_BAD_RESPONSE',
  'ERR_CANCELED',
  'INTERNAL_SERVER_ERROR',
  'BAD_REQUEST',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'NOT_FOUND',
  'TOO_MANY_REQUESTS',
  'SERVICE_UNAVAILABLE',
  'proxy-configuration-invalid',
  'login-failed',
  'login-timeout',
]);
const DiagnosticsSchema = z.object({
  code: ErrorCodeSchema.optional(),
  status: z.number().int().min(100).max(599).optional(),
  statusCode: z.number().int().min(100).max(599).optional(),
  durationMs: z.number().min(0).max(86_400_000).optional(),
  totalMs: z.number().min(0).max(86_400_000).optional(),
  retryCount: z.number().int().min(0).max(1000).optional(),
  hasExplicitProxy: z.boolean().optional(),
  success: z.boolean().optional(),
});
const SAFE_MESSAGES = new Set([
  'Upstream proxy is enabled but URL is not configured',
  'OpenTelemetry shutdown failed',
  'Core RPC request timed out',
  'Core RPC request was cancelled',
]);

/** Unknown prose, nested values and continuations are discarded, not regex-redacted. */
export function sanitizeLogRecord(message: string): { text: string; removed: boolean } {
  const stepMarker = 'Operation step v1 ';
  if (message.startsWith(stepMarker)) {
    try {
      const parsed: unknown = JSON.parse(message.slice(stepMarker.length));
      const step = OperationStepRecordSchema.safeParse(parsed);
      if (step.success) {
        return { text: `${stepMarker}${JSON.stringify(step.data)}`, removed: false };
      }
    } catch {
      // Only closed structured step records can retain the operation identity.
    }
  }
  const marker = 'Operation diagnostic v1 ';
  if (message.startsWith(marker)) {
    try {
      const parsed: unknown = JSON.parse(message.slice(marker.length));
      const diagnostic = parseCloudOperationDiagnostic(parsed);
      if (diagnostic) {
        return { text: `${marker}${JSON.stringify(diagnostic)}`, removed: false };
      }
    } catch {
      // A marker alone cannot authorize arbitrary prose, fields or nested data.
    }
  }
  if (SAFE_MESSAGES.has(message)) {
    return { text: message, removed: false };
  }
  let fields: z.infer<typeof DiagnosticsSchema> = {};
  // Winston appends JSON arguments to a message. Never retain that arbitrary prefix.
  const start = message.indexOf('{');
  if (start >= 0) {
    try {
      const parsed: unknown = JSON.parse(message.slice(start));
      // Validate fields independently: an invalid code must not discard a valid HTTP status.
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        for (const [key, schema] of Object.entries(DiagnosticsSchema.shape)) {
          const value = schema.safeParse(Reflect.get(parsed, key));
          if (value.success && value.data !== undefined) {
            fields = DiagnosticsSchema.parse({ ...fields, [key]: value.data });
          }
        }
      }
    } catch {
      // Malformed or multiline free text has no confirmed-safe structured diagnostics.
    }
  }
  return {
    text: `[Content removed]${Object.keys(fields).length ? ` ${JSON.stringify(fields)}` : ''}`,
    removed: true,
  };
}
