import * as state from './local-account-state.service';
import * as identity from './local-account-identity.service';
import { getCurrentAccountInfo } from './current-account.service';
import { logger } from '@/shared/logging/logger';
import { isErrorWithCode } from '@/shared/errors/error-guards';
import { AppError } from '@/shared/errors/appError';
import {
  LocalAccountError,
  LocalAccountInfoSchema,
  LocalAccountListSchema,
  LocalDeviceProfileSchema,
  LocalIdentitySnapshotSchema,
  projectLocalAccount,
  type LocalAccountErrorCode,
} from './local-account.schema';

export type LocalAccountPolicy = typeof state &
  typeof identity & {
    getCurrentAccountInfo: typeof getCurrentAccountInfo;
  };

/** Serializes local persistence policy without merging it with cloud-account imports. */
export function createLocalAccountOwner(policy: LocalAccountPolicy) {
  let accepting = true;
  let tail = Promise.resolve();
  const active = new Set<Promise<unknown>>();
  function execute<T>(
    code: LocalAccountErrorCode,
    write: boolean,
    work: () => Promise<T> | T,
  ): Promise<T> {
    if (!accepting) {
      return Promise.reject(new LocalAccountError('unavailable'));
    }
    const task = (write ? tail.then(work) : Promise.resolve().then(work)).catch(
      (error: unknown) => {
        if (error instanceof LocalAccountError) {
          throw error;
        }
        // Keep diagnostic categories without logging provider responses or credentials.
        logger.error('Local account action failed', {
          accountCode: code,
          errorKind: error instanceof Error ? error.name : 'unknown',
          errorCode:
            isErrorWithCode(error) && /^[A-Z_0-9-]{1,64}$/.test(error.code)
              ? error.code
              : undefined,
          processReason:
            error instanceof AppError && error.code === 'ANTIGRAVITY_PROCESS_FAILED'
              ? error.messageKey
              : undefined,
        });
        throw new LocalAccountError(code);
      },
    );
    if (write) {
      tail = task.then(
        () => undefined,
        () => undefined,
      );
    }
    active.add(task);
    void task.then(
      () => active.delete(task),
      () => active.delete(task),
    );
    return task;
  }
  return {
    closeAdmission: () => {
      accepting = false;
    },
    drain: async () => {
      await Promise.allSettled([...active]);
    },
    listAccounts: () =>
      execute('snapshot-unavailable', false, async () =>
        LocalAccountListSchema.parse((await policy.listAccountsData()).map(projectLocalAccount)),
      ),
    getCurrentAccountInfo: (appTarget?: Parameters<typeof getCurrentAccountInfo>[0]) =>
      execute('snapshot-unavailable', false, async () =>
        LocalAccountInfoSchema.parse(await policy.getCurrentAccountInfo(appTarget)),
      ),
    addAccountSnapshot: (appTarget?: Parameters<typeof state.addAccountSnapshot>[0]) =>
      execute('snapshot-unavailable', true, async () =>
        projectLocalAccount(await policy.addAccountSnapshot(appTarget)),
      ),
    switchAccount: (accountId: string, appTarget?: Parameters<typeof state.switchAccount>[1]) =>
      execute('restore-failed', true, () => policy.switchAccount(accountId, appTarget)),
    deleteAccount: (accountId: string) =>
      execute('account-operation-failed', true, () => policy.deleteAccount(accountId)),
    previewGenerateIdentityProfile: () =>
      execute('identity-failed', false, async () =>
        LocalDeviceProfileSchema.parse(await policy.previewGenerateIdentityProfile()),
      ),
    getIdentityProfiles: (accountId: string) =>
      execute('identity-failed', false, async () =>
        LocalIdentitySnapshotSchema.parse(await policy.getIdentityProfiles(accountId)),
      ),
    bindIdentityProfile: (accountId: string, mode: 'capture' | 'generate') =>
      execute('identity-failed', true, async () =>
        LocalDeviceProfileSchema.parse(await policy.bindIdentityProfile(accountId, mode)),
      ),
    bindIdentityProfileWithPayload: (
      accountId: string,
      profile: Parameters<typeof identity.bindIdentityProfileWithPayload>[1],
    ) =>
      execute('identity-failed', true, async () =>
        LocalDeviceProfileSchema.parse(
          await policy.bindIdentityProfileWithPayload(accountId, profile),
        ),
      ),
    applyBoundIdentityProfile: (accountId: string) =>
      execute('identity-failed', true, async () =>
        LocalDeviceProfileSchema.parse(await policy.applyBoundIdentityProfile(accountId)),
      ),
    restoreIdentityProfileRevision: (accountId: string, versionId: string) =>
      execute('identity-failed', true, async () =>
        LocalDeviceProfileSchema.parse(
          await policy.restoreIdentityProfileRevision(accountId, versionId),
        ),
      ),
    deleteIdentityProfileRevision: (accountId: string, versionId: string) =>
      execute('identity-failed', true, () =>
        policy.deleteIdentityProfileRevision(accountId, versionId),
      ),
    restoreBaselineProfile: (accountId: string) =>
      execute('identity-failed', true, async () =>
        LocalDeviceProfileSchema.parse(await policy.restoreBaselineProfile(accountId)),
      ),
  };
}
export const localAccountOwner = createLocalAccountOwner({
  ...state,
  ...identity,
  getCurrentAccountInfo,
});
export type LocalAccountOperations = Omit<
  ReturnType<typeof createLocalAccountOwner>,
  'closeAdmission' | 'drain'
>;
