import { z } from 'zod';
import { ProcessDiagnosticSchema } from './processDiagnostic';

export const ReportingReceiptSchema = z.discriminatedUnion('state', [
  z.strictObject({ state: z.literal('captured'), eventId: z.string().regex(/^[a-f0-9]{32}$/) }),
  z.strictObject({
    state: z.literal('not-reported'),
    reason: z.enum(['disabled', 'unconfigured', 'unavailable', 'expected-outcome']),
  }),
  z.strictObject({ state: z.literal('failed') }),
]);
export type ReportingReceipt = z.infer<typeof ReportingReceiptSchema>;

export const OperationStageSchema = z.enum([
  'client-selection',
  'callback-listen',
  'authorization-url',
  'browser-open',
  'authorization',
  'token-exchange',
  'user-info',
  'duplicate-check',
  'identity-preparation',
  'account-persist',
  'account-finalize',
  'view-load',
  'management-transport',
  'account-load',
  'token-refresh',
  'process-close',
  'target-write',
  'credential-readback',
  'process-start',
  'rollback',
]);
export const OperationReasonSchema = z.enum([
  'unknown',
  'dns-failed',
  'connection-refused',
  'connection-reset',
  'timed-out',
  'tls-failed',
  'network-failed',
  'proxy-configuration-invalid',
  'http-rejected',
  'malformed-response',
  'duplicate-account',
  'authorization-denied',
  'cancelled',
  'login-active',
  'storage-failed',
  'permission-denied',
  'locked',
  'unavailable',
  'credential-readback-mismatch',
  'process-close-failed',
  'process-start-failed',
  'account-not-found',
  'reauth-required',
  'identity-profile-required',
  'management-failed',
]);
export const NativeDiagnosticCodeSchema = z.enum([
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'ECONNABORTED',
  'EACCES',
  'EPERM',
  'ENOENT',
  'EIO',
  'ENOSPC',
  'SQLITE_BUSY',
  'SQLITE_LOCKED',
  'SQLITE_READONLY',
  'SQLITE_CORRUPT',
  'SQLITE_CANTOPEN',
  'CERT_HAS_EXPIRED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'permission-denied',
  'locked',
  'malformed',
  'timed-out',
  'unavailable',
  'ANTIGRAVITY_PROCESS_FAILED',
  'KEYCHAIN_UNAVAILABLE',
  'MASTER_KEY_UNAVAILABLE',
]);
export const UpstreamDiagnosticCodeSchema = z.enum([
  'invalid_grant',
  'invalid_client',
  'unauthorized_client',
  'invalid_request',
  'unsupported_grant_type',
  'access_denied',
  'temporarily_unavailable',
  'server_error',
  'invalid_scope',
  'RESOURCE_EXHAUSTED',
  'UNAUTHENTICATED',
  'PERMISSION_DENIED',
]);
/** Closed connection observations; no addresses, headers or response content cross the boundary. */
export const HttpResponseEvidenceSchema = z.strictObject({
  route: z.enum(['https-connect', 'forward-proxy', 'origin', 'unknown']),
  destination: z.enum(['loopback', 'non-loopback', 'unknown']),
  transport: z.enum(['tls', 'plain', 'unknown']),
  responseFormat: z.enum(['json', 'html', 'text', 'empty', 'other']),
});
export type HttpResponseEvidence = z.infer<typeof HttpResponseEvidenceSchema>;

export const CauseClassificationSchema = z.strictObject({
  reason: OperationReasonSchema,
  nativeCode: NativeDiagnosticCodeSchema.optional(),
  upstreamStatus: z.number().int().min(100).max(599).optional(),
  upstreamCode: UpstreamDiagnosticCodeSchema.optional(),
  http: HttpResponseEvidenceSchema.optional(),
  process: ProcessDiagnosticSchema.optional(),
});
export type CauseClassification = z.infer<typeof CauseClassificationSchema>;

export const OperationFailureSchema = z.strictObject({
  schemaVersion: z.literal(1),
  diagnosticId: z.uuid(),
  operation: z.enum(['google-login', 'cloud-account-switch']),
  stage: OperationStageSchema,
  ...CauseClassificationSchema.shape,
  accountCommit: z.enum(['not-attempted', 'confirmed', 'uncertain']).optional(),
  target: z.enum(['classic', 'ide', 'agy']).optional(),
  storage: z.enum(['credential-store', 'sqlite', 'cli-session']).optional(),
  rollback: z.enum(['not-attempted', 'succeeded', 'failed']).optional(),
  readback: z
    .strictObject({
      accessToken: z.boolean().optional(),
      refreshToken: z.boolean().optional(),
      idToken: z.boolean().optional(),
      expiry: z.boolean().optional(),
      projectId: z.boolean().optional(),
    })
    .optional(),
  causes: z.array(CauseClassificationSchema).max(4).optional(),
  causesTruncated: z.boolean().optional(),
});
export type OperationFailure = z.infer<typeof OperationFailureSchema>;
export const OperationDiagnosticSchema = OperationFailureSchema.extend({
  reporting: ReportingReceiptSchema,
}).refine(
  (value) => new TextEncoder().encode(JSON.stringify(value)).length <= 2048,
  'Operation diagnostic exceeds its byte budget',
);
export type OperationDiagnostic = z.infer<typeof OperationDiagnosticSchema>;
export const OperationObservationSchema = z.strictObject({
  stage: OperationStageSchema,
  outcome: z.enum(['started', 'succeeded', 'failed']),
});
export const OperationStepRecordSchema = OperationObservationSchema.extend({
  schemaVersion: z.literal(1),
  diagnosticId: z.uuid(),
  operation: OperationFailureSchema.shape.operation,
  truncated: z.literal(true).optional(),
});
export const OperationReportSchema = z.strictObject({
  failure: OperationFailureSchema,
  steps: z.array(OperationObservationSchema).max(12),
  stepsTruncated: z.boolean(),
  sourceLocations: z
    .array(
      z.strictObject({
        filename: z.enum([
          'src/modules/cloud-account/services/GoogleAPIService.ts',
          'src/modules/cloud-account/services/google-account-enrollment.service.ts',
          'src/modules/cloud-account/services/cloud-account-switch.service.ts',
          'src/modules/antigravity-runtime/credentials/clientAccountWrite.ts',
          'src/modules/antigravity-runtime/credentials/macosClientAccountWrite.ts',
        ]),
        lineno: z.number().int().min(1).max(1_000_000),
        colno: z.number().int().min(1).max(1_000_000),
      }),
    )
    .max(4)
    .optional(),
});
export type OperationReport = z.infer<typeof OperationReportSchema>;

// Select the carrier before validating: an invalid direct diagnostic must not fall through to data.
const OperationDiagnosticEnvelopeSchema = z
  .union([
    z.object({ diagnostic: z.unknown() }).transform(({ diagnostic }) => diagnostic),
    z
      .object({ data: z.object({ diagnostic: z.unknown() }) })
      .transform(({ data }) => data.diagnostic),
  ])
  .pipe(OperationDiagnosticSchema);

/** Only a validated finalized receipt suppresses ordinary forwarding captures. */
export function readFinalizedOperationDiagnostic(value: unknown): OperationDiagnostic | null {
  const parsed = OperationDiagnosticEnvelopeSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
