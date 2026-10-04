import { os, ORPCError } from '@orpc/server';
import { z } from 'zod';
import type { LocalAccountOperations } from './local-account-owner.service';
import {
  LocalAccountError,
  LocalAccountErrorCodeSchema,
  LocalAccountInfoSchema,
  LocalAccountListSchema,
  LocalAccountViewSchema,
  LocalDeviceProfileSchema,
  LocalIdentitySnapshotSchema,
  LocalAccountInputSchema,
  LocalAccountTargetInputSchema,
  LocalSwitchInputSchema,
  LocalBindInputSchema,
  LocalPayloadInputSchema,
  LocalRevisionInputSchema,
} from './local-account.schema';

async function operation<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    const remote =
      error instanceof ORPCError
        ? z.strictObject({ accountCode: LocalAccountErrorCodeSchema }).safeParse(error.data)
        : null;
    const accountCode =
      error instanceof LocalAccountError
        ? error.code
        : remote?.success
          ? remote.data.accountCode
          : 'unavailable';
    throw new ORPCError('SERVICE_UNAVAILABLE', {
      message: 'Unable to complete this account action right now. Please try again.',
      data: { accountCode },
    });
  }
}
export function createLocalAccountRouter(owner: LocalAccountOperations) {
  return os.router({
    listAccounts: os.output(LocalAccountListSchema).handler(() => operation(owner.listAccounts)),
    getCurrentAccountInfo: os
      .input(LocalAccountTargetInputSchema)
      .output(LocalAccountInfoSchema)
      .handler(({ input }) => operation(() => owner.getCurrentAccountInfo(input?.appTarget))),
    addAccountSnapshot: os
      .input(LocalAccountTargetInputSchema)
      .output(LocalAccountViewSchema)
      .handler(({ input }) => operation(() => owner.addAccountSnapshot(input?.appTarget))),
    switchAccount: os
      .input(LocalSwitchInputSchema)
      .output(z.void())
      .handler(({ input }) =>
        operation(() => owner.switchAccount(input.accountId, input.appTarget)),
      ),
    deleteAccount: os
      .input(LocalAccountInputSchema)
      .output(z.void())
      .handler(({ input }) => operation(() => owner.deleteAccount(input.accountId))),
    previewGenerateIdentityProfile: os
      .output(LocalDeviceProfileSchema)
      .handler(() => operation(owner.previewGenerateIdentityProfile)),
    getIdentityProfiles: os
      .input(LocalAccountInputSchema)
      .output(LocalIdentitySnapshotSchema)
      .handler(({ input }) => operation(() => owner.getIdentityProfiles(input.accountId))),
    bindIdentityProfile: os
      .input(LocalBindInputSchema)
      .output(LocalDeviceProfileSchema)
      .handler(({ input }) =>
        operation(() => owner.bindIdentityProfile(input.accountId, input.mode)),
      ),
    bindIdentityProfileWithPayload: os
      .input(LocalPayloadInputSchema)
      .output(LocalDeviceProfileSchema)
      .handler(({ input }) =>
        operation(() => owner.bindIdentityProfileWithPayload(input.accountId, input.profile)),
      ),
    applyBoundIdentityProfile: os
      .input(LocalAccountInputSchema)
      .output(LocalDeviceProfileSchema)
      .handler(({ input }) => operation(() => owner.applyBoundIdentityProfile(input.accountId))),
    restoreIdentityProfileRevision: os
      .input(LocalRevisionInputSchema)
      .output(LocalDeviceProfileSchema)
      .handler(({ input }) =>
        operation(() => owner.restoreIdentityProfileRevision(input.accountId, input.versionId)),
      ),
    deleteIdentityProfileRevision: os
      .input(LocalRevisionInputSchema)
      .output(z.void())
      .handler(({ input }) =>
        operation(() => owner.deleteIdentityProfileRevision(input.accountId, input.versionId)),
      ),
    restoreBaselineProfile: os
      .input(LocalAccountInputSchema)
      .output(LocalDeviceProfileSchema)
      .handler(({ input }) => operation(() => owner.restoreBaselineProfile(input.accountId))),
  });
}
