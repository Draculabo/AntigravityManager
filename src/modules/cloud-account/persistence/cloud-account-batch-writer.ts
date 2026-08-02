import type { CloudAccount } from '@/modules/cloud-account/types';
import { CloudAccountSchema } from '@/modules/cloud-account/types';
import { logger } from '@/shared/logging/logger';
import { accounts } from '@/shared/persistence/database/schema';
import { encrypt } from '@/shared/security/security';
import { getCloudDb } from './cloud-account-db';
import {
  serializeDeviceHistory,
  serializeDeviceProfile,
} from './cloud-account-device-profile-codec';

/**
 * Persist one prepared import plan in a single SQLite transaction.
 *
 * Callers must preserve account-owned fields before invoking this function.
 * Unlike CloudAccountRepo.addAccount(), this writer never changes unrelated
 * active-account rows because a background batch import must not switch users.
 */
export async function upsertCloudAccountsAtomically(
  accountsToPersist: CloudAccount[],
): Promise<void> {
  if (accountsToPersist.length === 0) {
    return;
  }

  const valuesToPersist = await Promise.all(
    accountsToPersist.map(async (account) => {
      CloudAccountSchema.parse(account);
      return {
        id: account.id,
        provider: account.provider,
        email: account.email,
        name: account.name ?? null,
        avatarUrl: account.avatar_url ?? null,
        tokenJson: await encrypt(JSON.stringify(account.token)),
        quotaJson: account.quota ? await encrypt(JSON.stringify(account.quota)) : null,
        deviceProfileJson: serializeDeviceProfile(account.device_profile),
        deviceHistoryJson: serializeDeviceHistory(account.device_history),
        createdAt: account.created_at,
        lastUsed: account.last_used,
        status: account.status ?? 'active',
        statusReason: account.status_reason ?? null,
        isActive: account.is_active ? 1 : 0,
        proxyUrl: account.proxy_url ?? null,
      };
    }),
  );

  const { raw, orm } = getCloudDb();
  try {
    orm.transaction((transaction) => {
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
