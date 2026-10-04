import { z } from 'zod';
import { AntigravityAppTargetSchema } from '@/shared/platform/antigravityAppTarget';

export const SyncFromIdeInputSchema = z.strictObject({
  appTarget: AntigravityAppTargetSchema.optional(),
});

export const IdeAccountSyncErrorCodeSchema = z.enum([
  'reauth-required',
  'no-ide-account',
  'ide-database-unavailable',
  'agy-unsupported',
  'sync-failed',
]);

export type IdeAccountSyncErrorCode = z.infer<typeof IdeAccountSyncErrorCodeSchema>;

export const IdeAccountSyncErrorDataSchema = z.strictObject({
  syncCode: IdeAccountSyncErrorCodeSchema,
});

export function readIdeAccountSyncErrorCode(error: unknown): IdeAccountSyncErrorCode | null {
  if (typeof error !== 'object' || error === null || !('data' in error)) {
    return null;
  }
  const result = IdeAccountSyncErrorDataSchema.safeParse(error.data);
  return result.success ? result.data.syncCode : null;
}
