import { and, desc, eq, sql } from 'drizzle-orm';
import { mergeQuotaWindows } from '../utils/quota-windows';
import { logger } from '@/shared/logging/logger';
import {
  CloudAccount,
  CloudAccountSchema,
  CloudAccountLifecycleGenerationSchema,
  CloudAccountHealthSchema,
  CloudQuotaDataSchema,
  CloudTokenDataSchema,
  type CloudQuotaData,
  type CloudTokenData,
} from '@/modules/cloud-account/types';
import { accounts } from '@/shared/persistence/database/schema';
import { isEncryptedPayloadCandidate } from '@/shared/security/crypto';
import { getCloudDb, type DrizzleExecutor } from './cloud-account-db';
import { convertEncryptedAccountFields } from './convert-encrypted-account-fields';
import { CloudAccountSettingsStore } from './cloud-account-settings-store';
import { CloudAccountProxyPrioritySchema } from '../services/cloud-account-routing.schema';
import type { AntigravityAppTarget } from '@/shared/platform/antigravityAppTarget';
import { assertImportPlanCurrent, cloudAccountRowValues } from './cloud-account-import-guard';
import {
  parseDeviceHistoryColumn,
  parseDeviceProfileColumn,
} from './cloud-account-device-profile-codec';
import { populateSyntheticArgonModels } from '@/modules/cloud-account/utils/quota-groups';
import { bindGoogleUsageIdentity, createGoogleUsageIdentity, googleUsageGrantHash, readGoogleUsageIdentity } from './google-usage-identity';

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
    const parsed = CloudQuotaDataSchema.parse(JSON.parse(value));
    populateSyntheticArgonModels(parsed.models, parsed.quota_groups);
    return parsed;
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
  const token = parseCloudToken(row.id, row.tokenJson);
  return {
    google_usage_subject_hash: readGoogleUsageIdentity(row.googleUsageIdentityJson, token),
    google_usage_grant_hash: googleUsageGrantHash(token) ?? undefined,
    lifecycle_generation: CloudAccountLifecycleGenerationSchema.parse(row.lifecycleGeneration),
    id: row.id,
    provider: row.provider as CloudAccount['provider'],
    email: row.email,
    name: row.name ?? undefined,
    avatar_url: row.avatarUrl ?? undefined,
    token,
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
    proxy_priority: row.proxyPriority ?? 50,
    proxy_enabled: row.proxyEnabled !== 0,
  };
}

export type CloudAccountWriteGuard = (current: CloudAccount | undefined) => void;

/** Admission rejected before insertion; no existing account is replaced or repaired. */
export class CloudAccountEmailConflictError extends Error {
  constructor() {
    super('Cloud account email already exists');
    this.name = 'CloudAccountEmailConflictError';
  }
}

/** The guard and mutation share one synchronous SQLite transaction; no awaited read/write gap. */
export function writeAccount(
  id: string,
  guard: CloudAccountWriteGuard | undefined,
  write: (transaction: DrizzleExecutor) => void,
): void {
  const { raw, orm } = getCloudDb();
  try {
    if (guard) {
      orm.transaction((transaction) => {
        const row = transaction.select().from(accounts).where(eq(accounts.id, id)).get();
        if (row) {
          assertPlainAccountFields(row);
        }
        guard(row ? parseAccountRow(row) : undefined);
        write(transaction);
      });
    } else {
      write(orm);
    }
  } finally {
    raw.close();
  }
}

export class CloudAccountRepo {
  private static versionFailureLogged = false;

  /** Synchronous completion check used before late request effects; it does not mutate storage. */
  static assertCurrentAccount(id: string, guard: CloudAccountWriteGuard): void {
    writeAccount(id, guard, () => {});
  }

  static async init(): Promise<void> {
    await convertEncryptedAccountFields();
    const { raw, orm } = getCloudDb();
    try {
      orm.transaction((transaction) => {
        CloudAccountSettingsStore.removeMissingActiveAccountReferences(transaction);
      });
    } finally {
      raw.close();
    }
    const [{ createProfileOAuthRecoveryJournal }, { recoverOAuthJournal }] = await Promise.all([
      import('./oauth-recovery-journal'),
      import('./oauth-recovery-service'),
    ]);
    await recoverOAuthJournal(createProfileOAuthRecoveryJournal());
  }

  static async addAccount(account: CloudAccount, expectedAccounts?: CloudAccount[]): Promise<void> {
    // Validate account data before processing
    CloudAccountSchema.parse(account);

    const { raw, orm } = getCloudDb();
    try {
      const values = cloudAccountRowValues(account);

      orm.transaction((transaction) => {
        if (expectedAccounts) {
          assertImportPlanCurrent(transaction, [account], expectedAccounts);
        }
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

  /** Email admission and the returned incarnation belong to the same insertion transaction. */
  static async insertAccount(account: CloudAccount, verifiedGoogleSubject?: string): Promise<CloudAccount> {
    CloudAccountSchema.parse(account);
    const { raw, orm } = getCloudDb();
    try {
      return orm.transaction(
        (transaction) => {
          // Match getAccountByEmail's JavaScript case folding without decoding stored credentials.
          const email = account.email.toLowerCase();
          const existingEmails = transaction.select({ email: accounts.email }).from(accounts).all();
          if (existingEmails.some((existing) => existing.email.toLowerCase() === email)) {
            throw new CloudAccountEmailConflictError();
          }
          transaction.insert(accounts).values({
            ...cloudAccountRowValues(account),
            googleUsageIdentityJson: verifiedGoogleSubject === undefined ? null : createGoogleUsageIdentity(verifiedGoogleSubject, account.token),
          }).run();
          const row = transaction.select().from(accounts).where(eq(accounts.id, account.id)).get();
          if (!row) {
            throw new Error('Inserted cloud account could not be read');
          }
          return parseAccountRow(row);
        },
        { behavior: 'immediate' },
      );
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
      orm.transaction((transaction) => {
        transaction.delete(accounts).where(eq(accounts.id, id)).run();
        CloudAccountSettingsStore.removeMissingActiveAccountReferences(transaction);
      });
      logger.info(`Removed cloud account: ${id}`);
    } finally {
      raw.close();
    }
  }

  static async updateToken(
    id: string,
    token: CloudTokenData,
    guard?: CloudAccountWriteGuard,
    trustedRefresh = false,
  ): Promise<void> {
    // Validate token data before persistence
    CloudTokenDataSchema.parse(token);
    if (trustedRefresh && !guard) {
      throw new Error('Trusted token refresh requires an account write guard');
    }

    let subject: string | undefined;
    writeAccount(id, (current) => {
      guard?.(current);
      if (current?.google_usage_subject_hash && (trustedRefresh || (
        googleUsageGrantHash(current.token) === googleUsageGrantHash(token)
      ))) {
        subject = current.google_usage_subject_hash;
      }
    }, (transaction) => {
      const tokenJson = JSON.stringify(token);
      const result = transaction
        .update(accounts)
        .set({ tokenJson, googleUsageIdentityJson: subject ? bindGoogleUsageIdentity(subject, token) : null })
        .where(eq(accounts.id, id))
        .run();
      if (result.changes === 0) {
        logger.warn(`updateToken: No account found with ID ${id}`);
      }
    });
  }

  static async compareAndUpdateToken(
    id: string,
    expected: CloudTokenData,
    token: CloudTokenData,
    guard?: CloudAccountWriteGuard,
    trustedRefresh = false,
  ): Promise<boolean> {
    if (trustedRefresh && !guard) {
      throw new Error('Trusted token refresh requires an account write guard');
    }
    const validated = CloudTokenDataSchema.parse(token);
    const expectedJson = JSON.stringify(CloudTokenDataSchema.parse(expected));
    let updated = false;
    let subject: string | undefined;
    writeAccount(id, (current) => {
      guard?.(current);
      if (
        current?.google_usage_subject_hash &&
        (trustedRefresh || googleUsageGrantHash(current.token) === googleUsageGrantHash(validated))
      ) {
        subject = current.google_usage_subject_hash;
      }
    }, (transaction) => {
      const row = transaction
        .select({ tokenJson: accounts.tokenJson })
        .from(accounts)
        .where(eq(accounts.id, id))
        .get();
      if (
        !row ||
        JSON.stringify(parseCloudToken(id, row.tokenJson)) !== expectedJson
      ) {
        return;
      }
      updated =
        transaction
          .update(accounts)
          .set({
            tokenJson: JSON.stringify(validated),
            googleUsageIdentityJson: subject ? bindGoogleUsageIdentity(subject, validated) : null,
          })
          .where(and(eq(accounts.id, id), eq(accounts.tokenJson, row.tokenJson)))
          .run().changes === 1;
    });
    return updated;
  }

  static async updateQuota(
    id: string,
    quota: CloudQuotaData,
    guard?: CloudAccountWriteGuard,
  ): Promise<void> {
    // Validate quota data before persistence
    CloudQuotaDataSchema.parse(quota);

    let reconciled = quota;
    writeAccount(
      id,
      (current) => {
        guard?.(current);
        reconciled = mergeQuotaWindows(current?.quota, quota);
      },
      (transaction) => {
        const quotaJson = JSON.stringify(reconciled);
        const result = transaction
          .update(accounts)
          .set({ quotaJson })
          .where(eq(accounts.id, id))
          .run();
        if (result.changes === 0) {
          logger.warn(`updateQuota: No account found with ID ${id}`);
        }
      },
    );
  }

  static async updateHealth(
    id: string,
    health: CloudAccount['health'],
    guard?: CloudAccountWriteGuard,
  ): Promise<void> {
    const parsedHealth = health === undefined ? undefined : CloudAccountHealthSchema.parse(health);
    writeAccount(id, guard, (transaction) => {
      const healthJson = parsedHealth ? JSON.stringify(parsedHealth) : null;
      const result = transaction
        .update(accounts)
        .set({ healthJson })
        .where(eq(accounts.id, id))
        .run();
      if (result.changes === 0) {
        throw new Error(`updateHealth: No account found with ID ${id}`);
      }
    });
  }

  static async compareAndUpdateHealth(
    id: string,
    expectedToken: CloudTokenData,
    expectedHealth: CloudAccount['health'],
    health: CloudAccount['health'],
    guard?: CloudAccountWriteGuard,
  ): Promise<boolean> {
    const parsedHealth = health === undefined ? undefined : CloudAccountHealthSchema.parse(health);
    const expectedTokenJson = JSON.stringify(CloudTokenDataSchema.parse(expectedToken));
    let updated = false;
    writeAccount(id, guard, (transaction) => {
      const row = transaction.select().from(accounts).where(eq(accounts.id, id)).get();
      if (
        !row ||
        JSON.stringify(parseCloudToken(id, row.tokenJson)) !== expectedTokenJson ||
        JSON.stringify(parseCloudHealth(id, row.healthJson)) !== JSON.stringify(expectedHealth)
      ) {
        return;
      }
      updated =
        transaction
          .update(accounts)
          .set({ healthJson: parsedHealth ? JSON.stringify(parsedHealth) : null })
          .where(
            and(
              eq(accounts.id, id),
              eq(accounts.tokenJson, row.tokenJson),
              sql`${accounts.healthJson} IS ${row.healthJson}`,
            ),
          )
          .run().changes === 1;
    });
    return updated;
  }

  static updateLastUsed(id: string, guard?: CloudAccountWriteGuard): void {
    writeAccount(id, guard, (transaction) => {
      transaction
        .update(accounts)
        .set({ lastUsed: Math.floor(Date.now() / 1000) })
        .where(eq(accounts.id, id))
        .run();
    });
  }

  /** Called after confirmed client write; all Manager finalization fields commit together. */
  static finalizeSwitch(
    id: string,
    target: AntigravityAppTarget | undefined,
    guard: CloudAccountWriteGuard,
  ): void {
    writeAccount(id, guard, (transaction) => {
      transaction.update(accounts).set({ isActive: 0 }).run();
      transaction
        .update(accounts)
        .set({
          isActive: 1,
          lastUsed: Math.floor(Date.now() / 1000),
          status: 'active',
          statusReason: null,
        })
        .where(eq(accounts.id, id))
        .run();
      CloudAccountSettingsStore.setActiveForTargetInTransaction(transaction, target, id);
    });
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

  static setAccountRouting(
    id: string,
    proxyPriority: number,
    proxyEnabled: boolean,
  ): void {
    const parsedPriority = CloudAccountProxyPrioritySchema.parse(proxyPriority);
    const { raw, orm } = getCloudDb();
    try {
      const result = orm
        .update(accounts)
        .set({
          proxyPriority: parsedPriority,
          proxyEnabled: proxyEnabled ? 1 : 0,
        })
        .where(eq(accounts.id, id))
        .run();
      if (result.changes === 0) {
        throw new Error(`Cloud account ${id} was not found`);
      }
    } finally {
      raw.close();
    }
  }

  static async setAccountStatus(
    id: string,
    status: CloudAccount['status'],
    reason?: string | null,
    guard?: CloudAccountWriteGuard,
  ): Promise<void> {
    writeAccount(id, guard, (transaction) => {
      transaction
        .update(accounts)
        .set({
          status,
          statusReason: reason?.trim() ? reason.trim() : null,
        })
        .where(eq(accounts.id, id))
        .run();
    });
  }

  static async getAccountByEmail(email: string): Promise<CloudAccount | null> {
    const allAccounts = await this.getAccounts();
    return (
      allAccounts.find((account) => account.email.toLowerCase() === email.toLowerCase()) || null
    );
  }
}
