import { z } from 'zod';
import { parseCloudOperationDiagnostic } from '@/modules/cloud-account/diagnostics';
import {
  OperationStepRecordSchema,
  OperationDiagnosticSchema,
} from '@/shared/observability/operationDiagnostic';
import { SwitchTraceSchema } from '@/shared/observability/switchDiagnostic';

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
const SAFE_MESSAGES = [
  'Upstream proxy is enabled but URL is not configured',
  'OpenTelemetry shutdown failed',
  'Core RPC request timed out',
  'Core RPC request was cancelled',
  'Failed to start NestJS server',
  'Standalone core service failed to start',
  'Service settings are unavailable; Core management remains available.',
  '[GoogleAPIService] Proxy configuration error',
  'Failed to close OAuth callback listener',
  'Failed to fetch initial quota',
  'Failed to refresh token before IDE injection',
  'Cloud account switch stopped before completion',
  'AppImageUpdater: verified download failed',
];
const PRIVATE_FIELD_NAME =
  /^(?:e[_-]?mail|account[_-]?id|(?:access|refresh|id|bearer)[_-]?token|token|(?:x[_-](?:goog[_-])?)?api[_-]?key|authorization|cookie|password|private[_-]?key|client[_-]?secret|secret|session[_-]?id|auth[_-]?code)$/i;

/** Export fixed diagnostic messages and validated fields from otherwise untrusted log records. */
export function sanitizeLogRecord(message: string): { text: string; removed: boolean } {
  const switchMarker = 'Switch trace v1 ';
  if (message.startsWith(switchMarker)) {
    try {
      const trace = SwitchTraceSchema.safeParse(JSON.parse(message.slice(switchMarker.length)));
      if (trace.success) {
        return { text: `${switchMarker}${JSON.stringify(trace.data)}`, removed: false };
      }
    } catch {
      /* Only closed switch evidence is exportable. */
    }
  }
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
      const local = OperationDiagnosticSchema.safeParse(parsed);
      if (local.success && local.data.operation === 'local-account-switch') {
        return { text: `${marker}${JSON.stringify(local.data)}`, removed: false };
      }
    } catch {
      // A marker alone cannot authorize arbitrary prose, fields or nested data.
    }
  }
  const safeMessage = SAFE_MESSAGES.find(
    (candidate) => message === candidate || message.startsWith(`${candidate} `),
  );
  if (message === safeMessage) {
    return { text: safeMessage, removed: false };
  }
  let fields: z.infer<typeof DiagnosticsSchema> = {};
  let maskedFields: [string, string][] = [];
  // Log arguments follow the fixed message. For unknown messages, still project safe numeric and closed fields.
  const start = safeMessage ? safeMessage.length + 1 : message.indexOf('{');
  const args = start >= 0 ? message.slice(start) : '';
  if (args.startsWith('{')) {
    try {
      const parsed: unknown = JSON.parse(args);
      // Validate fields independently: an invalid code must not discard a valid HTTP status.
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        for (const [key, schema] of Object.entries(DiagnosticsSchema.shape)) {
          const value = schema.safeParse(Reflect.get(parsed, key));
          if (value.success && value.data !== undefined) {
            fields = DiagnosticsSchema.parse({ ...fields, [key]: value.data });
          }
        }
        if (safeMessage) {
          maskedFields = Object.keys(parsed)
            .filter((key) => PRIVATE_FIELD_NAME.test(key))
            .map((key) => [key, '***']);
        }
      }
    } catch {
      // Malformed or multiline free text has no confirmed-safe structured diagnostics.
    }
  }
  const projected = { ...fields, ...Object.fromEntries(maskedFields) };
  const details = Object.keys(projected).length ? ` ${JSON.stringify(projected)}` : '';
  return {
    text: safeMessage ? `${safeMessage}${details || ' ***'}` : `[Content removed]${details}`,
    removed: true,
  };
}
