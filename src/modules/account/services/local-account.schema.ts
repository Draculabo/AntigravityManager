import { z } from 'zod';
import type { Account } from '../types';
import { AntigravityAppTargetSchema } from '@/shared/platform/antigravityAppTarget';

const short = z.string().max(256);
export const LocalAccountIdSchema = short.min(1);
// The existing index/history formats remain unchanged; these schemas bound transport data.
export const LocalDeviceProfileSchema = z.strictObject({
  machineId: short,
  macMachineId: short,
  devDeviceId: short,
  sqmId: short,
});
const revision = z.strictObject({
  id: short,
  createdAt: z.number().finite().nonnegative(),
  label: short,
  profile: LocalDeviceProfileSchema,
  isCurrent: z.boolean(),
});
export const LocalIdentitySnapshotSchema = z.strictObject({
  currentStorage: LocalDeviceProfileSchema.optional(),
  boundProfile: LocalDeviceProfileSchema.optional(),
  history: z.array(revision).max(256),
  baseline: LocalDeviceProfileSchema.optional(),
});
export const LocalAccountViewSchema = z.strictObject({
  id: LocalAccountIdSchema,
  name: short,
  email: short,
  avatar_url: z.string().max(4096).optional(),
  deviceProfile: LocalDeviceProfileSchema.optional(),
  deviceHistory: z.array(revision).max(256).optional(),
  created_at: z.string().max(64),
  last_used: z.string().max(64),
});
export const LocalAccountListSchema = z.array(LocalAccountViewSchema).max(2048);
export const LocalAccountInfoSchema = z.strictObject({
  email: short,
  name: short.optional(),
  isAuthenticated: z.boolean(),
});
export const LocalAccountInputSchema = z.strictObject({ accountId: LocalAccountIdSchema });
export const LocalAccountTargetInputSchema = z
  .strictObject({
    appTarget: AntigravityAppTargetSchema.optional(),
  })
  .optional();
export const LocalSwitchInputSchema = LocalAccountInputSchema.extend({
  appTarget: AntigravityAppTargetSchema.optional(),
});
export const LocalBindInputSchema = LocalAccountInputSchema.extend({
  mode: z.enum(['capture', 'generate']),
});
export const LocalPayloadInputSchema = LocalAccountInputSchema.extend({
  profile: LocalDeviceProfileSchema,
});
export const LocalRevisionInputSchema = LocalAccountInputSchema.extend({
  versionId: short.min(1),
});
export const LocalAccountErrorCodeSchema = z.enum([
  'invalid-input',
  'unavailable',
  'snapshot-unavailable',
  'snapshot-not-found',
  'credential-unavailable',
  'restore-failed',
  'identity-failed',
  'account-operation-failed',
]);
export type LocalAccountErrorCode = z.infer<typeof LocalAccountErrorCodeSchema>;
export class LocalAccountError extends Error {
  constructor(readonly code: LocalAccountErrorCode) {
    super('Unable to complete this account action right now. Please try again.');
  }
}
export function projectLocalAccount(account: Account) {
  return LocalAccountViewSchema.parse({
    id: account.id,
    name: account.name,
    email: account.email,
    avatar_url: account.avatar_url,
    deviceProfile: account.deviceProfile,
    deviceHistory: account.deviceHistory,
    created_at: account.created_at,
    last_used: account.last_used,
  });
}
