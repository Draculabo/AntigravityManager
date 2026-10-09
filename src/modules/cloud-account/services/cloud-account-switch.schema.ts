import { z } from 'zod';
import { CloudAccountIdSchema } from './cloud-account-mutation.schema';
import { AntigravityAppTargetSchema } from '@/shared/platform/antigravityAppTarget';

export const CloudAccountSwitchInputSchema = z.strictObject({
  accountId: CloudAccountIdSchema,
  appTarget: AntigravityAppTargetSchema.optional(),
});

export const CloudAccountSwitchResultSchema = z.strictObject({ success: z.literal(true) });

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

const CloudAccountSwitchErrorDataSchema = z.strictObject({
  switchCode: CloudAccountSwitchErrorCodeSchema,
});

export function readCloudAccountSwitchErrorCode(
  error: unknown,
): CloudAccountSwitchErrorCode | null {
  if (typeof error !== 'object' || error === null || !('data' in error)) {
    return null;
  }
  const result = CloudAccountSwitchErrorDataSchema.safeParse(error.data);
  return result.success ? result.data.switchCode : null;
}
