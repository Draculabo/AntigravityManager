import type { RouterClient } from '@orpc/server';
import { z } from 'zod';
import type { CoreRpcRouter } from '@/core/rpc/router';
import type { LocalAccountOperations } from './local-account-owner.service';
import {
  LocalAccountInfoSchema,
  LocalAccountListSchema,
  LocalAccountViewSchema,
  LocalDeviceProfileSchema,
  LocalIdentitySnapshotSchema,
} from './local-account.schema';

export function createLocalAccountClient(
  read: RouterClient<CoreRpcRouter>['localAccount'],
  write: RouterClient<CoreRpcRouter>['localAccount'],
): LocalAccountOperations {
  return {
    listAccounts: async () => LocalAccountListSchema.parse(await read.listAccounts()),
    getCurrentAccountInfo: async (appTarget) =>
      LocalAccountInfoSchema.parse(
        await read.getCurrentAccountInfo({ appTarget: appTarget ?? undefined }),
      ),
    addAccountSnapshot: async (appTarget) =>
      LocalAccountViewSchema.parse(await write.addAccountSnapshot({ appTarget })),
    switchAccount: async (accountId, appTarget) => {
      z.void().parse(await write.switchAccount({ accountId, appTarget }));
    },
    deleteAccount: async (accountId) => {
      z.void().parse(await write.deleteAccount({ accountId }));
    },
    previewGenerateIdentityProfile: async () =>
      LocalDeviceProfileSchema.parse(await read.previewGenerateIdentityProfile()),
    getIdentityProfiles: async (accountId) =>
      LocalIdentitySnapshotSchema.parse(await read.getIdentityProfiles({ accountId })),
    bindIdentityProfile: async (accountId, mode) =>
      LocalDeviceProfileSchema.parse(await write.bindIdentityProfile({ accountId, mode })),
    bindIdentityProfileWithPayload: async (accountId, profile) =>
      LocalDeviceProfileSchema.parse(
        await write.bindIdentityProfileWithPayload({ accountId, profile }),
      ),
    applyBoundIdentityProfile: async (accountId) =>
      LocalDeviceProfileSchema.parse(await write.applyBoundIdentityProfile({ accountId })),
    restoreIdentityProfileRevision: async (accountId, versionId) =>
      LocalDeviceProfileSchema.parse(
        await write.restoreIdentityProfileRevision({ accountId, versionId }),
      ),
    deleteIdentityProfileRevision: async (accountId, versionId) => {
      z.void().parse(await write.deleteIdentityProfileRevision({ accountId, versionId }));
    },
    restoreBaselineProfile: async (accountId) =>
      LocalDeviceProfileSchema.parse(await write.restoreBaselineProfile({ accountId })),
  };
}
