import { z } from 'zod';
import { CloudAccountIdSchema } from './cloud-account-mutation.schema';
import { AntigravityAppTargetSchema } from '@/shared/platform/antigravityAppTarget';
import { CloudSwitchDiagnosticSchema } from './operation-diagnostic.schema';

export const CloudAccountSwitchInputSchema = z.strictObject({
  accountId: CloudAccountIdSchema,
  appTarget: AntigravityAppTargetSchema.optional(),
});

export const CloudAccountSwitchResultSchema = z.strictObject({ success: z.literal(true) });
export const CoreCloudAccountSwitchInputSchema = CloudAccountSwitchInputSchema.extend({
  diagnosticId: z.uuid(),
});

export const CloudAccountSwitchErrorCodeSchema = z.enum([
  'account-not-found',
  'reauth-required',
  'identity-profile-required',
  'process-close-failed',
  'process-control-failed',
  'target-write-failed',
  'switch-failed',
]);

export type CloudAccountSwitchErrorCode = z.infer<typeof CloudAccountSwitchErrorCodeSchema>;

const CloudAccountSwitchORPCErrorDataSchema = z
  .object({
    switchCode: CloudAccountSwitchErrorCodeSchema,
    diagnostic: CloudSwitchDiagnosticSchema.optional(),
  })
  .strip();

export type CloudAccountSwitchORPCErrorData = z.infer<typeof CloudAccountSwitchORPCErrorDataSchema>;

export function parseCloudAccountSwitchORPCErrorData(
  value: unknown,
): CloudAccountSwitchORPCErrorData | null {
  const result = CloudAccountSwitchORPCErrorDataSchema.safeParse(value);
  return result.success ? result.data : null;
}

export function readCloudAccountSwitchErrorCode(
  error: unknown,
): CloudAccountSwitchErrorCode | null {
  if (typeof error !== 'object' || error === null || !('data' in error)) {
    return null;
  }
  return parseCloudAccountSwitchORPCErrorData(error.data)?.switchCode ?? null;
}
