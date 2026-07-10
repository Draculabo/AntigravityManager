import { desc, eq } from 'drizzle-orm';
import { logger } from '@/shared/logging/logger';
import {
  CloudAccount,
  CloudAccountSchema,
  CloudQuotaDataSchema,
  CloudTokenDataSchema,
} from '@/modules/cloud-account/types';
import { decryptWithMigration, encrypt, type KeySource } from '@/shared/security/security';
import { getAppErrorData } from '@/shared/errors/appError';
import { accounts } from '@/shared/persistence/database/schema';
import { type DrizzleExecutor, getCloudDb } from './cloud-account-db';
import {
  parseDeviceHistoryColumn,
  parseDeviceProfileColumn,
  serializeDeviceHistory,
  serializeDeviceProfile,
} from './cloud-account-device-profile-codec';

function isDataMigrationError(error: unknown): boolean {
  return getAppErrorData(error)?.appErrorCode === 'DATA_MIGRATION_FAILED';
}

interface MigrationStats {
  totalFields: number;
  fallbackUsedFields: number;
  migratedFields: number;
  migratedBySource: Record<KeySource, number>;
  failedFields: number;
}

function createMigrationStats(): MigrationStats {
  return {
    totalFields: 0,
    fallbackUsedFields: 0,
    migratedFields: 0,
    migratedBySource: {
      safeStorage: 0,
      keytar: 0,
      file: 0,
    },
    failedFields: 0,
  };
}

async function decryptAndMigrateField(
  orm: DrizzleExecutor,
  accountId: string,
  field: 'tokenJson' | 'quotaJson',
  value: string | null,
): Promise<{ value: string | null; migrated: boolean; usedFallback?: KeySource }> {
  if (!value) {
    return { value: null, migrated: false };
  }

  const result = await decryptWithMigration(value);
  if (result.reencrypted) {
    if (field === 'tokenJson') {
      orm
        .update(accounts)
        .set({ tokenJson: result.reencrypted })
        .where(eq(accounts.id, accountId))
        .run();
    } else {
      orm
        .update(accounts)
        .set({ quotaJson: result.reencrypted })
        .where(eq(accounts.id, accountId))
        .run();
    }
    logger.info(
      `Migrated ${field} for account ${accountId} from ${result.usedFallback ?? 'unknown'} key`,
    );
  }

  return {
    value: result.value,
    migrated: Boolean(result.reencrypted),
    usedFallback: result.usedFallback,
  };
}

type DecryptFieldResult = Awaited<ReturnType<typeof decryptAndMigrateField>>;

export class CloudAccountRepo {
  private static versionFailureLogged = false;

  static async init(): Promise<void> {
    const { raw } = getCloudDb();
    raw.close();
    await this.migrateToEncrypted();
  }

  static async migrateToEncrypted(): Promise<void> {
    const { raw, orm } = getCloudDb();
    try {
      const rows = orm
        .select({
          id: accounts.id,
          tokenJson: accounts.tokenJson,
          quotaJson: accounts.quotaJson,
        })
        .from(accounts)
        .all();

      for (const row of rows) {
        let changed = false;
        let newToken = row.tokenJson;
        let newQuota = row.quotaJson;

        // Check if plain text (starts with {)
        if (newToken && newToken.startsWith('{')) {
          newToken = await encrypt(newToken);
          changed = true;
        }
        if (newQuota && newQuota.startsWith('{')) {
          newQuota = await encrypt(newQuota);
          changed = true;
        }

        if (changed) {
          orm
            .update(accounts)
            .set({ tokenJson: newToken, quotaJson: newQuota })
            .where(eq(accounts.id, row.id))
            .run();
          logger.info(`Migrated account ${row.id} to encrypted storage`);
        }
      }
    } catch (error) {
      logger.error('Failed to migrate data', error);
    } finally {
      raw.close();
    }
  }

  static async addAccount(account: CloudAccount): Promise<void> {
    // Validate account data before processing
    CloudAccountSchema.parse(account);

    const { raw, orm } = getCloudDb();
    try {
      const tokenEncrypted = await encrypt(JSON.stringify(account.token));
      const quotaEncrypted = account.quota ? await encrypt(JSON.stringify(account.quota)) : null;
      const values = {
        id: account.id,
        provider: account.provider,
        email: account.email,
        name: account.name ?? null,
        avatarUrl: account.avatar_url ?? null,
        tokenJson: tokenEncrypted,
        quotaJson: quotaEncrypted,
        deviceProfileJson: serializeDeviceProfile(account.device_profile),
        deviceHistoryJson: serializeDeviceHistory(account.device_history),
        createdAt: account.created_at,
        lastUsed: account.last_used,
        status: account.status || 'active',
        statusReason: account.status_reason ?? null,
        isActive: account.is_active ? 1 : 0,
        proxyUrl: account.proxy_url ?? null,
      };

      orm.transaction((transaction) => {
        // If this account is being set to active, deactivate all others first
        if (account.is_active) {
          logger.debug(
            `Deactivating other cloud accounts because ${account.email} is being marked active`,
          );
          const deactivationResult = transaction.update(accounts).set({ isActive: 0 }).run();
          logger.debug(`Deactivated ${deactivationResult.changes} cloud account rows`);
        }
        transaction
          .insert(accounts)
          .values(values)
          .onConflictDoUpdate({
            target: accounts.id,
            set: values,
          })
          .run();
      });
      logger.info(`Added/Updated cloud account: ${account.email}`);
    } finally {
      raw.close();
    }
  }

  static async getAccounts(): Promise<CloudAccount[]> {
    const { raw, orm } = getCloudDb();
    const migrationStats = createMigrationStats();

    try {
      const rows = orm.select().from(accounts).orderBy(desc(accounts.lastUsed)).all();

      const activeRows = rows.filter((row) => row.isActive);
      logger.debug(`Loaded ${rows.length} cloud accounts; ${activeRows.length} are active.`);
      activeRows.forEach((row) => logger.debug(`Active cloud account: ${row.email} (${row.id})`));

      const cloudAccounts: CloudAccount[] = [];
      for (const normalizedRow of rows) {
        try {
          let tokenResult: DecryptFieldResult;
          try {
            tokenResult = await decryptAndMigrateField(
              orm,
              normalizedRow.id,
              'tokenJson',
              normalizedRow.tokenJson,
            );
          } catch (error) {
            migrationStats.failedFields += 1;
            logger.error(`Failed to decrypt token for account ${normalizedRow.id}`, error);
            if (isDataMigrationError(error)) {
              throw error;
            }
            continue; // Skip corrupted account
          }

          let quotaResult: DecryptFieldResult;
          try {
            quotaResult = await decryptAndMigrateField(
              orm,
              normalizedRow.id,
              'quotaJson',
              normalizedRow.quotaJson,
            );
          } catch (error) {
            migrationStats.failedFields += 1;
            logger.error(`Failed to decrypt quota for account ${normalizedRow.id}`, error);
            if (isDataMigrationError(error)) {
              throw error;
            }
            quotaResult = { value: null, migrated: false }; // Quota is optional, proceed
          }

          if (!tokenResult.value) {
            logger.warn(`Missing token data for account ${normalizedRow.id}`);
            continue;
          }

          if (tokenResult.value) {
            migrationStats.totalFields += 1;
          }
          if (tokenResult.usedFallback) {
            migrationStats.fallbackUsedFields += 1;
          }
          if (tokenResult.migrated) {
            migrationStats.migratedFields += 1;
            if (tokenResult.usedFallback) {
              migrationStats.migratedBySource[tokenResult.usedFallback] += 1;
            }
          }

          if (quotaResult.value) {
            migrationStats.totalFields += 1;
          }
          if (quotaResult.usedFallback) {
            migrationStats.fallbackUsedFields += 1;
          }
          if (quotaResult.migrated) {
            migrationStats.migratedFields += 1;
            if (quotaResult.usedFallback) {
              migrationStats.migratedBySource[quotaResult.usedFallback] += 1;
            }
          }

          cloudAccounts.push({
            id: normalizedRow.id,
            provider: normalizedRow.provider as CloudAccount['provider'],
            email: normalizedRow.email,
            name: normalizedRow.name ?? undefined,
            avatar_url: normalizedRow.avatarUrl ?? undefined,
            token: JSON.parse(tokenResult.value),
            quota: quotaResult.value ? JSON.parse(quotaResult.value) : undefined,
            device_profile: parseDeviceProfileColumn(normalizedRow.deviceProfileJson),
            device_history: parseDeviceHistoryColumn(normalizedRow.deviceHistoryJson),
            created_at: normalizedRow.createdAt,
            last_used: normalizedRow.lastUsed,
            status: (normalizedRow.status as CloudAccount['status']) ?? undefined,
            status_reason: normalizedRow.statusReason ?? undefined,
            is_active: Boolean(normalizedRow.isActive),
            proxy_url: normalizedRow.proxyUrl ?? undefined,
          });
        } catch (rowError) {
          if (isDataMigrationError(rowError)) {
            throw rowError;
          }
          logger.error(`Unexpected error processing row for account ${normalizedRow.id}`, rowError);
          continue;
        }
      }

      return cloudAccounts;
    } finally {
      if (
        migrationStats.migratedFields > 0 ||
        migrationStats.fallbackUsedFields > 0 ||
        migrationStats.failedFields > 0
      ) {
        const summary = {
          totalFields: migrationStats.totalFields,
          fallbackUsedFields: migrationStats.fallbackUsedFields,
          migratedFields: migrationStats.migratedFields,
          migratedBySource: migrationStats.migratedBySource,
          failedFields: migrationStats.failedFields,
        };
        if (migrationStats.failedFields > 0) {
          logger.warn('CloudAccountRepo migration summary (with failures)', summary);
        } else {
          logger.info('CloudAccountRepo migration summary', summary);
        }
      }
      raw.close();
    }
  }

  static async getAccount(id: string): Promise<CloudAccount | undefined> {
    const { raw, orm } = getCloudDb();

    try {
      const rows = orm.select().from(accounts).where(eq(accounts.id, id)).all();
      const normalizedRow = rows[0];
      if (!normalizedRow) {
        return undefined;
      }

      let tokenResult: DecryptFieldResult;
      try {
        tokenResult = await decryptAndMigrateField(
          orm,
          normalizedRow.id,
          'tokenJson',
          normalizedRow.tokenJson,
        );
      } catch (error) {
        logger.error(
          `[CloudAccountRepo] getAccount ${id} failed - Decryption failed for token`,
          error,
        );
        if (isDataMigrationError(error)) {
          throw error;
        }
        return undefined;
      }

      let quotaResult: DecryptFieldResult;
      try {
        quotaResult = await decryptAndMigrateField(
          orm,
          normalizedRow.id,
          'quotaJson',
          normalizedRow.quotaJson,
        );
      } catch (error) {
        logger.error(
          `[CloudAccountRepo] getAccount ${id} failed - Decryption failed for quota`,
          error,
        );
        if (isDataMigrationError(error)) {
          throw error;
        }
        quotaResult = { value: null, migrated: false };
      }

      const tokenValue = tokenResult.value;
      if (!tokenValue) {
        return undefined;
      }

      return {
        id: normalizedRow.id,
        provider: normalizedRow.provider as CloudAccount['provider'],
        email: normalizedRow.email,
        name: normalizedRow.name ?? undefined,
        avatar_url: normalizedRow.avatarUrl ?? undefined,
        token: JSON.parse(tokenValue),
        quota: quotaResult.value ? JSON.parse(quotaResult.value) : undefined,
        device_profile: parseDeviceProfileColumn(normalizedRow.deviceProfileJson),
        device_history: parseDeviceHistoryColumn(normalizedRow.deviceHistoryJson),
        created_at: normalizedRow.createdAt,
        last_used: normalizedRow.lastUsed,
        status: (normalizedRow.status as CloudAccount['status']) ?? undefined,
        status_reason: normalizedRow.statusReason ?? undefined,
        is_active: Boolean(normalizedRow.isActive),
        proxy_url: normalizedRow.proxyUrl ?? undefined,
      };
    } finally {
      raw.close();
    }
  }

  static async removeAccount(id: string): Promise<void> {
    const { raw, orm } = getCloudDb();
    try {
      orm.delete(accounts).where(eq(accounts.id, id)).run();
      logger.info(`Removed cloud account: ${id}`);
    } finally {
      raw.close();
    }
  }

  static async updateToken(id: string, token: any): Promise<void> {
    // Validate token data before encryption
    CloudTokenDataSchema.parse(token);

    const { raw, orm } = getCloudDb();

    try {
      const encrypted = await encrypt(JSON.stringify(token));
      const result = orm
        .update(accounts)
        .set({ tokenJson: encrypted })
        .where(eq(accounts.id, id))
        .run();
      if (result.changes === 0) {
        logger.warn(`updateToken: No account found with ID ${id}`);
      }
    } finally {
      raw.close();
    }
  }

  static async updateQuota(id: string, quota: any): Promise<void> {
    // Validate quota data before encryption
    CloudQuotaDataSchema.parse(quota);

    const { raw, orm } = getCloudDb();

    try {
      const encrypted = await encrypt(JSON.stringify(quota));
      const result = orm
        .update(accounts)
        .set({ quotaJson: encrypted })
        .where(eq(accounts.id, id))
        .run();
      if (result.changes === 0) {
        logger.warn(`updateQuota: No account found with ID ${id}`);
      }
    } finally {
      raw.close();
    }
  }

  static updateLastUsed(id: string): void {
    const { raw, orm } = getCloudDb();
    try {
      orm
        .update(accounts)
        .set({ lastUsed: Math.floor(Date.now() / 1000) })
        .where(eq(accounts.id, id))
        .run();
    } finally {
      raw.close();
    }
  }

  static setActive(id: string): void {
    const { raw, orm } = getCloudDb();

    try {
      orm.transaction((transaction) => {
        transaction.update(accounts).set({ isActive: 0 }).run();
        transaction.update(accounts).set({ isActive: 1 }).where(eq(accounts.id, id)).run();
      });
      logger.info(`Set account ${id} as active`);
    } finally {
      raw.close();
    }
  }

  static setAccountProxy(id: string, proxyUrl: string | null): void {
    const { raw, orm } = getCloudDb();
    try {
      orm.update(accounts).set({ proxyUrl }).where(eq(accounts.id, id)).run();
      logger.info(`Updated proxy for account ${id}: ${proxyUrl ?? 'none'}`);
    } catch (error) {
      logger.error(`Failed to update proxy for account ${id}`, error);
      throw error;
    } finally {
      raw.close();
    }
  }

  static async setAccountStatus(
    id: string,
    status: CloudAccount['status'],
    reason?: string | null,
  ): Promise<void> {
    const { raw, orm } = getCloudDb();
    try {
      orm
        .update(accounts)
        .set({
          status,
          statusReason: reason?.trim() ? reason.trim() : null,
        })
        .where(eq(accounts.id, id))
        .run();
    } finally {
      raw.close();
    }
  }

  static async getAccountByEmail(email: string): Promise<CloudAccount | null> {
    const allAccounts = await this.getAccounts();
    return (
      allAccounts.find((account) => account.email.toLowerCase() === email.toLowerCase()) || null
    );
  }
}
