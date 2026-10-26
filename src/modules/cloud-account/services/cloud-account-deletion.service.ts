import { CloudAccountRepo } from '../persistence/cloudHandler';

/** Durable deletion commits first; a cleanup failure must never pretend the row was restored. */
export async function deleteCloudAccount(accountId: string): Promise<void> {
  const { forgetDeletedNestServerAccount } = await import('@/server/main');
  const { serviceConfigService } = await import('@/modules/config/service-config.service');
  await CloudAccountRepo.removeAccount(accountId);
  const isStillDeleted = () => {
    let absent = false;
    CloudAccountRepo.assertCurrentAccount(accountId, (current) => {
      absent = current === undefined;
    });
    return absent;
  };
  const failures: unknown[] = [];
  try {
    if (isStillDeleted()) {
      forgetDeletedNestServerAccount(accountId);
    }
  } catch (cause) {
    failures.push(cause);
  }
  try {
    await serviceConfigService.clearDeletedAccountPreference(accountId, isStillDeleted);
  } catch (cause) {
    failures.push(cause);
  }
  if (failures.length > 0) {
    throw new CloudAccountDeletionCleanupError(
      failures.length === 1
        ? failures[0]
        : new AggregateError(failures, 'Account deletion cleanup failed', { cause: failures[0] }),
    );
  }
}

export class CloudAccountDeletionCleanupError extends Error {
  constructor(cause: unknown) {
    super('Account deleted, but state cleanup failed. Check the account list before retrying.', {
      cause,
    });
    this.name = 'CloudAccountDeletionCleanupError';
  }
}
