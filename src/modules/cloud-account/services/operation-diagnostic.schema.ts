import { z } from 'zod';
import {
  OperationFailureSchema,
  ReportingReceiptSchema,
} from '@/shared/observability/operationDiagnostic';

export const GoogleLoginStageSchema = OperationFailureSchema.shape.stage.extract([
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
]);
export const CloudSwitchStageSchema = OperationFailureSchema.shape.stage.extract([
  'account-load',
  'client-selection',
  'token-refresh',
  'identity-preparation',
  'process-close',
  'target-write',
  'credential-readback',
  'process-start',
  'rollback',
  'management-transport',
  'account-finalize',
]);
const LoginDiagnosticShape = OperationFailureSchema.omit({
  target: true,
  storage: true,
  rollback: true,
  readback: true,
  switchRecovery: true,
  credentialWrite: true,
}).extend({
  operation: z.literal('google-login'),
  stage: GoogleLoginStageSchema,
  accountCommit: OperationFailureSchema.shape.accountCommit.unwrap(),
  reporting: ReportingReceiptSchema,
});
const SwitchDiagnosticShape = OperationFailureSchema.omit({ accountCommit: true }).extend({
  operation: z.literal('cloud-account-switch'),
  stage: CloudSwitchStageSchema,
  reporting: ReportingReceiptSchema,
});
export const CloudOperationDiagnosticSchema = z
  .discriminatedUnion('operation', [LoginDiagnosticShape, SwitchDiagnosticShape])
  .refine(
    (value) => new TextEncoder().encode(JSON.stringify(value)).length <= 2048,
    'Diagnostic exceeds its byte budget',
  );
export const GoogleLoginDiagnosticSchema = LoginDiagnosticShape.refine(
  (value) => new TextEncoder().encode(JSON.stringify(value)).length <= 2048,
);
export const CloudSwitchDiagnosticSchema = SwitchDiagnosticShape.refine(
  (value) => new TextEncoder().encode(JSON.stringify(value)).length <= 2048,
);
export type GoogleLoginDiagnostic = z.infer<typeof GoogleLoginDiagnosticSchema>;
export type CloudSwitchDiagnostic = z.infer<typeof CloudSwitchDiagnosticSchema>;
export type CloudOperationDiagnostic = z.infer<typeof CloudOperationDiagnosticSchema>;

export function parseCloudOperationDiagnostic(value: unknown): CloudOperationDiagnostic | null {
  const result = CloudOperationDiagnosticSchema.safeParse(value);
  return result.success ? result.data : null;
}
