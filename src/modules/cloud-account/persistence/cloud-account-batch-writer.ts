import type { CloudAccount } from '@/modules/cloud-account/types';
import { CloudAccountSchema } from '@/modules/cloud-account/types';
import { logger } from '@/shared/logging/logger';
import { accounts } from '@/shared/persistence/database/schema';
import { getCloudDb } from './cloud-account-db';
import {
  assertImportPlanCurrent,
  cloudAccountImportUpdateValues,
  cloudAccountRowValues,
} from './cloud-account-import-guard';

/**
 * Persist one prepared import plan in a single SQLite transaction.
 *
 * Callers must preserve account-owned fields before invoking this function.
 * Preserve the stored Google identity only when the guarded import keeps the same grant.
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

  const expectedById = new Map(expectedAccounts?.map((account) => [account.id, account]));
  const valuesToPersist = accountsToPersist.map((account) => {
    CloudAccountSchema.parse(account);
    const values = cloudAccountRowValues(account);
    const update = cloudAccountImportUpdateValues(account, values, expectedById.get(account.id));
    return { values, update };
  });

  const { raw, orm } = getCloudDb();
  try {
    orm.transaction((transaction) => {
      if (expectedAccounts) {
        assertImportPlanCurrent(transaction, accountsToPersist, expectedAccounts);
      }
      for (const { values, update } of valuesToPersist) {
        transaction
          .insert(accounts)
          .values(values)
          .onConflictDoUpdate({
            target: accounts.id,
            set: update,
          })
          .run();
      }
    });
    logger.info(`Persisted ${valuesToPersist.length} locally discovered cloud accounts`);
  } finally {
    raw.close();
  }
}
