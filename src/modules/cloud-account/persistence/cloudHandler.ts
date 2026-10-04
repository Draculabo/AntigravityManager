import { desc, eq } from 'drizzle-orm';
import { logger } from '@/shared/logging/logger';
import {
  CloudAccount,
  CloudAccountSchema,
  CloudAccountHealthSchema,
  CloudQuotaDataSchema,
  CloudTokenDataSchema,
  type CloudQuotaData,
  type CloudTokenData,
} from '@/modules/cloud-account/types';
import { accounts } from '@/shared/persistence/database/schema';
import { isEncryptedPayloadCandidate } from '@/shared/security/crypto';
import { getCloudDb } from './cloud-account-db';
import { convertEncryptedAccountFields } from './convert-encrypted-account-fields';
import {
  parseDeviceHistoryColumn,
  parseDeviceProfileColumn,
  serializeDeviceHistory,
  serializeDeviceProfile,
} from './cloud-account-device-profile-codec';

function parseCloudToken(accountId: string, value: string): CloudAccount['token'] {
  try {
    return CloudTokenDataSchema.parse(JSON.parse(value));
  } catch (error) {
    logger.error(`Invalid token data for account ${accountId}`, error);
    throw error;
  }
}

function parseCloudQuota(
  accountId: string,
  value: string | null,
): CloudAccount['quota'] | undefined {
  if (!value) {
    return undefined;
  }

  try {
    return CloudQuotaDataSchema.parse(JSON.parse(value));
  } catch (error) {
    logger.warn(`Invalid quota for account ${accountId}, continuing without quota`, error);
    return undefined;
  }
}

function parseCloudHealth(
  accountId: string,
  value: string | null,
): CloudAccount['health'] | undefined {
  if (!value) {
    return undefined;
  }

  try {
    return CloudAccountHealthSchema.parse(JSON.parse(value));
  } catch (error) {
    logger.error(`Invalid health data for account ${accountId}`, error);
    throw error;
  }
}

type AccountRow = typeof accounts.$inferSelect;

function assertPlainAccountFields(row: AccountRow): void {
  if ([row.tokenJson, row.quotaJson, row.healthJson].some(isEncryptedPayloadCandidate)) {
    throw new Error('Encrypted account fields must be converted before reading accounts');
  }
}

function parseAccountRow(row: AccountRow): CloudAccount {
  return {
    id: row.id,
    provider: row.provider as CloudAccount['provider'],
    email: row.email,
    name: row.name ?? undefined,
    avatar_url: row.avatarUrl ?? undefined,
    token: parseCloudToken(row.id, row.tokenJson),
    quota: parseCloudQuota(row.id, row.quotaJson),
    health: parseCloudHealth(row.id, row.healthJson),
    device_profile: parseDeviceProfileColumn(row.deviceProfileJson),
    device_history: parseDeviceHistoryColumn(row.deviceHistoryJson),
    created_at: row.createdAt,
    last_used: row.lastUsed,
    status: (row.status as CloudAccount['status']) ?? undefined,
    status_reason: row.statusReason ?? undefined,
    is_active: Boolean(row.isActive),
    proxy_url: row.proxyUrl ?? undefined,
  };
}

export class CloudAccountRepo {
  private static versionFailureLogged = false;

  static async init(): Promise<void> {
    await convertEncryptedAccountFields();
  }

  static async addAccount(account: CloudAccount): Promise<void> {
    // Validate account data before processing
    CloudAccountSchema.parse(account);

    const { raw, orm } = getCloudDb();
    try {
      const values = {
        id: account.id,
        provider: account.provider,
        email: account.email,
        name: account.name ?? null,
        avatarUrl: account.avatar_url ?? null,
        tokenJson: JSON.stringify(account.token),
        quotaJson: account.quota ? JSON.stringify(account.quota) : null,
        healthJson: account.health ? JSON.stringify(account.health) : null,
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
    try {
      const rows = orm.select().from(accounts).orderBy(desc(accounts.lastUsed)).all();
      const cloudAccounts: CloudAccount[] = [];
      for (const row of rows) {
        assertPlainAccountFields(row);
        try {
          if (!row.tokenJson) {
            logger.warn(`Missing token data for account ${row.id}`);
            continue;
          }
          cloudAccounts.push(parseAccountRow(row));
        } catch (error) {
          logger.error(`Invalid stored account ${row.id}`, error);
        }
      }
      return cloudAccounts;
    } finally {
      raw.close();
    }
  }

  static async getAccount(id: string): Promise<CloudAccount | undefined> {
    const { raw, orm } = getCloudDb();
    try {
      const row = orm.select().from(accounts).where(eq(accounts.id, id)).get();
      if (!row) {
        return undefined;
      }
      assertPlainAccountFields(row);
      return parseAccountRow(row);
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

  static async updateToken(id: string, token: CloudTokenData): Promise<void> {
    // Validate token data before persistence
    CloudTokenDataSchema.parse(token);

    const { raw, orm } = getCloudDb();

    try {
      const tokenJson = JSON.stringify(token);
      const result = orm.update(accounts).set({ tokenJson }).where(eq(accounts.id, id)).run();
      if (result.changes === 0) {
        logger.warn(`updateToken: No account found with ID ${id}`);
      }
    } finally {
      raw.close();
    }
  }

  static async updateQuota(id: string, quota: CloudQuotaData): Promise<void> {
    // Validate quota data before persistence
    CloudQuotaDataSchema.parse(quota);

    const { raw, orm } = getCloudDb();

    try {
      const quotaJson = JSON.stringify(quota);
      const result = orm.update(accounts).set({ quotaJson }).where(eq(accounts.id, id)).run();
      if (result.changes === 0) {
        logger.warn(`updateQuota: No account found with ID ${id}`);
      }
    } finally {
      raw.close();
    }
  }

  static async updateHealth(id: string, health: CloudAccount['health']): Promise<void> {
    const parsedHealth = health === undefined ? undefined : CloudAccountHealthSchema.parse(health);
    const { raw, orm } = getCloudDb();
    try {
      const healthJson = parsedHealth ? JSON.stringify(parsedHealth) : null;
      const result = orm.update(accounts).set({ healthJson }).where(eq(accounts.id, id)).run();
      if (result.changes === 0) {
        throw new Error(`updateHealth: No account found with ID ${id}`);
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
      logger.info(
        `Updated proxy for account ${id}: ${proxyUrl === null ? 'removed' : 'configured'}`,
      );
    } catch {
      logger.error(`Failed to update proxy for account ${id}`);
      throw new Error('Failed to update account proxy');
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
