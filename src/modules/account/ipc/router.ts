import { z } from 'zod';
import { os } from '@orpc/server';
import {
  applyBoundIdentityProfile,
  addAccountSnapshot,
  bindIdentityProfile,
  bindIdentityProfileWithPayload,
  deleteAccount,
  deleteIdentityProfileRevision,
  getIdentityProfiles,
  listAccountsData,
  previewGenerateIdentityProfile,
  restoreBaselineProfile,
  restoreIdentityProfileRevision,
  switchAccount,
  openIdentityStorageFolder,
} from './handler';
import { AccountSchema, AntigravityAppTargetSchema } from '@/modules/account/types';
import {
  DeviceProfileSchema,
  DeviceProfilesSnapshotSchema,
} from '@/modules/identity-profile/types';

export const accountRouter = os.router({
  listAccounts: os.output(z.array(AccountSchema)).handler(async () => {
    return listAccountsData();
  }),

  addAccountSnapshot: os.output(AccountSchema).handler(async () => {
    return addAccountSnapshot();
  }),

  switchAccount: os
    .input(z.object({ accountId: z.string(), appTarget: AntigravityAppTargetSchema.optional() }))
    .output(z.void())
    .handler(async ({ input }) => {
      await switchAccount(input.accountId, input.appTarget);
    }),

  deleteAccount: os
    .input(z.object({ accountId: z.string() }))
    .output(z.void())
    .handler(async ({ input }) => {
      await deleteAccount(input.accountId);
    }),

  previewGenerateIdentityProfile: os.output(DeviceProfileSchema).handler(async () => {
    return previewGenerateIdentityProfile();
  }),

  getIdentityProfiles: os
    .input(z.object({ accountId: z.string() }))
    .output(DeviceProfilesSnapshotSchema)
    .handler(async ({ input }) => {
      return getIdentityProfiles(input.accountId);
    }),

  bindIdentityProfile: os
    .input(z.object({ accountId: z.string(), mode: z.enum(['capture', 'generate']) }))
    .output(DeviceProfileSchema)
    .handler(async ({ input }) => {
      return bindIdentityProfile(input.accountId, input.mode);
    }),

  bindIdentityProfileWithPayload: os
    .input(z.object({ accountId: z.string(), profile: DeviceProfileSchema }))
    .output(DeviceProfileSchema)
    .handler(async ({ input }) => {
      return bindIdentityProfileWithPayload(input.accountId, input.profile);
    }),

  applyBoundIdentityProfile: os
    .input(z.object({ accountId: z.string() }))
    .output(DeviceProfileSchema)
    .handler(async ({ input }) => {
      return applyBoundIdentityProfile(input.accountId);
    }),

  restoreIdentityProfileRevision: os
    .input(z.object({ accountId: z.string(), versionId: z.string() }))
    .output(DeviceProfileSchema)
    .handler(async ({ input }) => {
      return restoreIdentityProfileRevision(input.accountId, input.versionId);
    }),

  deleteIdentityProfileRevision: os
    .input(z.object({ accountId: z.string(), versionId: z.string() }))
    .output(z.void())
    .handler(async ({ input }) => {
      await deleteIdentityProfileRevision(input.accountId, input.versionId);
    }),

  restoreBaselineProfile: os
    .input(z.object({ accountId: z.string() }))
    .output(DeviceProfileSchema)
    .handler(async ({ input }) => {
      return restoreBaselineProfile(input.accountId);
    }),

  openIdentityStorageFolder: os.output(z.void()).handler(async () => {
    await openIdentityStorageFolder();
  }),
});
