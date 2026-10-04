import { z } from 'zod';
import { CloudAccountIdSchema } from './cloud-account-mutation.schema';

export const CloudIdentityProfileSchema = z.strictObject({
  machineId: z.string().min(1).max(4096),
  macMachineId: z.string().min(1).max(4096),
  devDeviceId: z.string().min(1).max(4096),
  sqmId: z.string().min(1).max(4096),
});

const CloudIdentityProfileVersionSchema = z.strictObject({
  id: z.string().min(1).max(256),
  createdAt: z.number().finite(),
  label: z.string().max(512),
  profile: CloudIdentityProfileSchema,
  isCurrent: z.boolean(),
});

export const CloudIdentityProfilesSnapshotSchema = z.strictObject({
  currentStorage: CloudIdentityProfileSchema.optional(),
  boundProfile: CloudIdentityProfileSchema.optional(),
  history: z.array(CloudIdentityProfileVersionSchema),
  baseline: CloudIdentityProfileSchema.optional(),
});

export const CloudIdentityProfileAccountInputSchema = z.strictObject({
  accountId: CloudAccountIdSchema,
});
export const CloudIdentityProfileBindInputSchema = CloudIdentityProfileAccountInputSchema.extend({
  mode: z.enum(['capture', 'generate']),
});
export const CloudIdentityProfilePayloadInputSchema = CloudIdentityProfileAccountInputSchema.extend(
  {
    profile: CloudIdentityProfileSchema,
  },
);
export const CloudIdentityProfileRevisionIdSchema = z.string().min(1).max(256);
export const CloudIdentityProfileRevisionInputSchema =
  CloudIdentityProfileAccountInputSchema.extend({
    versionId: CloudIdentityProfileRevisionIdSchema,
  });
export const CloudIdentityProfileMutationResultSchema = z.strictObject({
  success: z.literal(true),
});

export const CloudIdentityProfileErrorCodeSchema = z.enum([
  'account-not-found',
  'baseline-unavailable',
  'revision-not-found',
  'profile-invalid',
  'profile-write-failed',
  'profile-operation-failed',
]);
export type CloudIdentityProfileErrorCode = z.infer<typeof CloudIdentityProfileErrorCodeSchema>;

const CloudIdentityProfileErrorDataSchema = z.strictObject({
  profileCode: CloudIdentityProfileErrorCodeSchema,
});

export function readCloudIdentityProfileErrorCode(
  error: unknown,
): CloudIdentityProfileErrorCode | null {
  if (typeof error !== 'object' || error === null || !('data' in error)) {
    return null;
  }
  const parsed = CloudIdentityProfileErrorDataSchema.safeParse(error.data);
  return parsed.success ? parsed.data.profileCode : null;
}
