import type { CloudAccount } from '@/modules/cloud-account/types';
import { CloudAccountSchema } from '@/modules/cloud-account/types';
import { logger } from '@/shared/logging/logger';
import { accounts } from '@/shared/persistence/database/schema';
import { getCloudDb } from './cloud-account-db';
import { assertImportPlanCurrent, cloudAccountRowValues } from './cloud-account-import-guard';

/**
 * Persist one prepared import plan in a single SQLite transaction.
 *
 * Callers must preserve account-owned fields before invoking this function.
 * Unlike CloudAccountRepo.addAccount(), this writer never changes unrelated
 * active-account rows because a background batch import must not switch users.
 */
export async function upsertCloudAccountsAtomically(
  accountsToPersist: CloudAccount[],
  expectedAccounts?: CloudAccount[],
): Promise<void> {
  if (accountsToPersist.length === 0) {
    return;
  }

  const valuesToPersist = accountsToPersist.map((account) => {
    CloudAccountSchema.parse(account);
    return cloudAccountRowValues(account);
  });

  const { raw, orm } = getCloudDb();
  try {
    orm.transaction((transaction) => {
      if (expectedAccounts) {
        assertImportPlanCurrent(transaction, accountsToPersist, expectedAccounts);
      }
      for (const values of valuesToPersist) {
        transaction
          .insert(accounts)
          .values(values)
          .onConflictDoUpdate({
            target: accounts.id,
            set: values,
          })
          .run();
      }
    });
    logger.info(`Persisted ${valuesToPersist.length} locally discovered cloud accounts`);
  } finally {
    raw.close();
  }
}
