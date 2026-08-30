import fs from 'fs';
import { eq } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { isObjectLike, isString } from 'lodash-es';
import {
  type AntigravityAppTarget,
  resolveAntigravityAppTarget,
} from '@/shared/platform/antigravityAppTarget';
import {
  getAntigravityVersion,
  isCredentialStoreVersion,
  isNewVersion,
} from '@/modules/antigravity-runtime/utils/antigravityVersion';
import type { CloudAccount } from '@/modules/cloud-account/types';
import { logger } from '@/shared/logging/logger';
import { getAntigravityDbPaths } from '@/shared/platform/paths';
import { openDrizzleConnection } from '@/shared/persistence/database/dbConnection';
import { itemTable } from '@/shared/persistence/database/schema';
import * as drizzleSchema from '@/shared/persistence/database/schema';
import { ItemTableValueRowSchema } from '@/shared/persistence/database/types';
import { parseRow } from '@/shared/persistence/database/sqlite';
import { ProtobufUtils } from '@/shared/serialization/protobuf';
import { writeAntigravityCredentialStoreToken } from './antigravityCredentialStore';

const SQLITE_BUSY_CODES = new Set(['SQLITE_BUSY', 'SQLITE_LOCKED']);
const SQLITE_BUSY_TIMEOUT_MS = 3000;
const SQLITE_RETRY_DELAY_MS = 150;
const SQLITE_MAX_RETRIES = 3;

type DrizzleExecutor = Pick<
  BetterSQLite3Database<typeof drizzleSchema>,
  'insert' | 'update' | 'delete' | 'select'
>;

function isSqliteBusyError(error: unknown): boolean {
  if (!isObjectLike(error)) {
    return false;
  }
  const err = error as { code?: string; message?: string };
  if (err.code && SQLITE_BUSY_CODES.has(err.code)) {
    return true;
  }
  if (isString(err.message)) {
    return err.message.includes('SQLITE_BUSY') || err.message.includes('SQLITE_LOCKED');
  }
  return false;
}

function sleepSync(ms: number): void {
  const buffer = new SharedArrayBuffer(4);
  const array = new Int32Array(buffer);
  Atomics.wait(array, 0, 0, ms);
}

function getIdeDb(
  dbPath: string,
  readOnly: boolean,
): { raw: import('better-sqlite3').Database; orm: BetterSQLite3Database<typeof drizzleSchema> } {
  return openDrizzleConnection(
    dbPath,
    { readonly: readOnly },
    { readOnly, busyTimeoutMs: SQLITE_BUSY_TIMEOUT_MS },
  );
}

function upsertItemValue(db: DrizzleExecutor, key: string, value: string): void {
  db.insert(itemTable)
    .values({ key, value })
    .onConflictDoUpdate({
      target: itemTable.key,
      set: { value },
    })
    .run();
}

function getItemValue(db: DrizzleExecutor, key: string, context: string): string | null {
  const rows = db
    .select({ value: itemTable.value })
    .from(itemTable)
    .where(eq(itemTable.key, key))
    .all();
  const row = parseRow(ItemTableValueRowSchema, rows[0], context);
  return row?.value ?? null;
}

function shouldWriteGcpTos(account: CloudAccount): boolean {
  if (account.token.oauth_client_key === 'antigravity_enterprise') {
    return false;
  }

  return account.token.is_gcp_tos ?? false;
}

function writeAuthStatusAndCleanup(db: DrizzleExecutor, account: CloudAccount): void {
  const authStatus = {
    name: account.name || account.email,
    email: account.email,
    apiKey: account.token.access_token,
  };

  upsertItemValue(db, 'antigravityAuthStatus', JSON.stringify(authStatus));
  upsertItemValue(db, 'antigravityOnboarding', 'true');
  db.delete(itemTable).where(eq(itemTable.key, 'google.antigravity')).run();
}

export class CredentialStoreInjectionAdapter {
  private static versionFailureLogged = false;

  private static assertTokenUsableForInjection(account: CloudAccount): void {
    const hasRefreshToken =
      isString(account.token.refresh_token) && account.token.refresh_token.trim().length > 0;
    const now = Math.floor(Date.now() / 1000);

    if (!hasRefreshToken && account.token.expiry_timestamp <= now) {
      throw new Error(
        `Cannot inject expired access token for ${account.email} without a refresh token. Please re-login.`,
      );
    }
  }

  private static injectNewFormat(
    orm: BetterSQLite3Database<typeof drizzleSchema>,
    account: CloudAccount,
  ): void {
    const oauthInfo = ProtobufUtils.createOAuthInfo(
      account.token.access_token,
      account.token.refresh_token,
      account.token.expiry_timestamp,
      shouldWriteGcpTos(account),
      account.token.id_token,
      account.email,
    );
    const userStatusPayload = ProtobufUtils.createMinimalUserStatusPayload(account.email);
    const userStatusEntry = ProtobufUtils.createUnifiedStateEntry(
      'userStatusSentinelKey',
      userStatusPayload,
    );
    const normalizedProjectId = account.token.project_id?.trim();

    orm.transaction((transaction) => {
      const existingOauthToken = getItemValue(
        transaction,
        'antigravityUnifiedStateSync.oauthToken',
        'ide.itemTable.antigravityUnifiedStateSync.oauthToken',
      );
      let oauthToken = ProtobufUtils.createUnifiedStateEntry(
        'oauthTokenInfoSentinelKey',
        oauthInfo,
      );
      if (existingOauthToken) {
        try {
          const existingTopic = new Uint8Array(Buffer.from(existingOauthToken, 'base64'));
          const mergedTopic = ProtobufUtils.replaceUnifiedTopicEntry(
            existingTopic,
            'oauthTokenInfoSentinelKey',
            oauthInfo,
          );
          oauthToken = Buffer.from(mergedTopic).toString('base64');
        } catch (error) {
          logger.warn(
            'Failed to merge existing unified OAuth topic; replacing OAuth token entry',
            error,
          );
        }
      }

      upsertItemValue(transaction, 'antigravityUnifiedStateSync.oauthToken', oauthToken);
      upsertItemValue(transaction, 'antigravityUnifiedStateSync.userStatus', userStatusEntry);
      transaction
        .delete(itemTable)
        .where(eq(itemTable.key, 'jetskiStateSync.agentManagerInitState'))
        .run();
      if (normalizedProjectId) {
        const projectPayload = ProtobufUtils.createStringValuePayload(normalizedProjectId);
        const projectEntry = ProtobufUtils.createUnifiedStateEntry(
          'enterpriseGcpProjectId',
          projectPayload,
        );
        upsertItemValue(
          transaction,
          'antigravityUnifiedStateSync.enterprisePreferences',
          projectEntry,
        );
      } else {
        transaction
          .delete(itemTable)
          .where(eq(itemTable.key, 'antigravityUnifiedStateSync.enterprisePreferences'))
          .run();
      }
      writeAuthStatusAndCleanup(transaction, account);
    });
  }

  private static injectOldFormat(
    orm: BetterSQLite3Database<typeof drizzleSchema>,
    account: CloudAccount,
  ): void {
    const encodedAgentState = getItemValue(
      orm,
      'jetskiStateSync.agentManagerInitState',
      'ide.itemTable.jetskiStateSync.agentManagerInitState',
    );

    orm.transaction((transaction) => {
      if (!encodedAgentState) {
        logger.warn(
          'jetskiStateSync.agentManagerInitState not found. ' +
            'Injecting minimal auth state only. User may need to complete onboarding in the IDE first.',
        );

        writeAuthStatusAndCleanup(transaction, account);

        logger.info(
          `Injected minimal auth state for ${account.email} (no protobuf state available)`,
        );
        return;
      }

      const encodedStateBuffer = Buffer.from(encodedAgentState, 'base64');
      const agentStateBytes = new Uint8Array(encodedStateBuffer);
      const stateWithoutPreviousToken = ProtobufUtils.removeField(agentStateBytes, 6);
      const oauthTokenField = ProtobufUtils.createOAuthTokenInfo(
        account.token.access_token,
        account.token.refresh_token,
        account.token.expiry_timestamp,
      );

      const updatedAgentStateBytes = new Uint8Array(
        stateWithoutPreviousToken.length + oauthTokenField.length,
      );
      updatedAgentStateBytes.set(stateWithoutPreviousToken, 0);
      updatedAgentStateBytes.set(oauthTokenField, stateWithoutPreviousToken.length);

      const updatedEncodedAgentState = Buffer.from(updatedAgentStateBytes).toString('base64');

      transaction
        .update(itemTable)
        .set({ value: updatedEncodedAgentState })
        .where(eq(itemTable.key, 'jetskiStateSync.agentManagerInitState'))
        .run();

      writeAuthStatusAndCleanup(transaction, account);
    });
  }

  private static detectFormatCapability(db: DrizzleExecutor): 'new' | 'old' | 'dual' | null {
    const unifiedValue = getItemValue(
      db,
      'antigravityUnifiedStateSync.oauthToken',
      'ide.itemTable.antigravityUnifiedStateSync.oauthToken',
    );
    const oldValue = getItemValue(
      db,
      'jetskiStateSync.agentManagerInitState',
      'ide.itemTable.jetskiStateSync.agentManagerInitState',
    );

    if (unifiedValue && oldValue) {
      return 'dual';
    }
    if (unifiedValue) {
      return 'new';
    }
    if (oldValue) {
      return 'old';
    }

    return null;
  }

  static shouldInjectTokenIntoCredentialStore(appTarget?: AntigravityAppTarget): boolean {
    const resolvedTarget = resolveAntigravityAppTarget(appTarget);
    if (resolvedTarget === 'agy') {
      return true;
    }
    if (resolvedTarget === 'ide') {
      return false;
    }

    try {
      const version = getAntigravityVersion(appTarget);

      // Some Linux builds expose Chromium/Electron engine versions instead of product versions.
      const parts = version.shortVersion.split('.');
      if (parts.length >= 2) {
        const secondPart = parseInt(parts[1], 10);
        if (secondPart >= 100) {
          logger.info(
            `Version ${version.shortVersion} appears to be a Chromium engine version, ` +
              `defaulting to credential store for Classic Antigravity`,
          );
          return true;
        }
      }

      return isCredentialStoreVersion(version);
    } catch (error) {
      logger.warn(
        'Version detection failed; defaulting to credential store for Classic Antigravity',
        error,
      );
      return true;
    }
  }

  private static resolveInjectionStrategy(
    db: DrizzleExecutor,
    appTarget?: AntigravityAppTarget,
  ): {
    name: 'new' | 'old' | 'dual';
    reason: string;
  } {
    try {
      const version = getAntigravityVersion(appTarget);
      return {
        name: isNewVersion(version) ? 'new' : 'old',
        reason: `version:${version.shortVersion}`,
      };
    } catch (error) {
      if (!this.versionFailureLogged) {
        logger.warn('Version detection failed, falling back to capability detection', error);
        this.versionFailureLogged = true;
      }
    }

    const capability = this.detectFormatCapability(db);
    if (capability) {
      return { name: capability, reason: 'capability' };
    }

    return { name: 'dual', reason: 'fallback' };
  }

  private static getStrategy(name: 'new' | 'old'): {
    name: 'new' | 'old';
    inject: (db: BetterSQLite3Database<typeof drizzleSchema>, account: CloudAccount) => void;
  } {
    if (name === 'new') {
      return { name, inject: (db, account) => this.injectNewFormat(db, account) };
    }
    return { name, inject: (db, account) => this.injectOldFormat(db, account) };
  }

  private static injectWithRetry(
    dbPath: string,
    account: CloudAccount,
    appTarget?: AntigravityAppTarget,
  ): { strategy: string; attempts: number } {
    let lastError: unknown;
    for (let attempt = 1; attempt <= SQLITE_MAX_RETRIES; attempt += 1) {
      const { raw, orm } = getIdeDb(dbPath, false);
      try {
        const { name, reason } = this.resolveInjectionStrategy(orm, appTarget);
        if (name === 'dual') {
          let newInjected = false;
          let oldInjected = false;

          try {
            this.injectNewFormat(orm, account);
            newInjected = true;
          } catch (newError) {
            logger.warn('Failed to inject new format', newError);
          }

          try {
            this.injectOldFormat(orm, account);
            oldInjected = true;
          } catch (oldError) {
            logger.warn('Failed to inject old format', oldError);
          }

          if (!newInjected && !oldInjected) {
            throw new Error('Token injection failed for both formats');
          }

          return { strategy: `dual:${reason}`, attempts: attempt };
        }

        const strategy = this.getStrategy(name);
        strategy.inject(orm, account);
        return { strategy: `${strategy.name}:${reason}`, attempts: attempt };
      } catch (error) {
        lastError = error;
        if (isSqliteBusyError(error) && attempt < SQLITE_MAX_RETRIES) {
          logger.warn(`SQLite busy, retrying injection (attempt ${attempt})`, error);
          sleepSync(SQLITE_RETRY_DELAY_MS);
          continue;
        }
        throw error;
      } finally {
        raw.close();
      }
    }

    throw lastError;
  }

  static injectCloudToken(account: CloudAccount, appTarget?: AntigravityAppTarget): void {
    const dbPaths = getAntigravityDbPaths(appTarget);
    const dbPath = dbPaths.find((candidatePath) => fs.existsSync(candidatePath)) ?? null;

    if (!dbPath) {
      throw new Error(`Antigravity database not found. Checked paths: ${dbPaths.join(', ')}`);
    }

    const result = this.injectWithRetry(dbPath, account, appTarget);
    logger.info(
      `Successfully injected cloud token and identity for ${account.email} into Antigravity database at ${dbPath} (strategy=${result.strategy}, attempts=${result.attempts}).`,
    );
  }

  static injectCloudTokenWithStorageStrategy(
    account: CloudAccount,
    appTarget?: AntigravityAppTarget,
  ): 'credential-store' | 'sqlite' {
    this.assertTokenUsableForInjection(account);

    if (this.shouldInjectTokenIntoCredentialStore(appTarget)) {
      if (appTarget === 'agy') {
        writeAntigravityCredentialStoreToken(account.token, {
          email: account.email,
          syncGoogleOAuthFiles: true,
        });
      } else {
        writeAntigravityCredentialStoreToken(account.token);
      }
      return 'credential-store';
    }

    this.injectCloudToken(account, appTarget);
    return 'sqlite';
  }
}
