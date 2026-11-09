import type { Logger } from '@nestjs/common';
import type {
  AccountLeaseAccountStore,
  AccountLeaseUpstream,
} from '../interfaces/account-lease-adapters';
import {
  type AccountLeaseTokenData,
  normalizeClientKey,
  normalizeProjectId,
} from '../interfaces/account-lease-token-types';
import { CloudAccountRefreshBlockedError } from '@/modules/cloud-account/services/CloudAccountRefreshService';
import { OAuthTokenRefreshError } from '@/modules/cloud-account/services/GoogleAPIService';
import type { OAuthRecoveryJournal } from '@/modules/cloud-account/persistence/oauth-recovery-journal';

type AccountLeaseHydrationLogger = Pick<Logger, 'debug' | 'error' | 'log' | 'warn'>;

interface AccountLeaseHydrationPolicyOptions {
  accountStore: AccountLeaseAccountStore;
  upstream: AccountLeaseUpstream;
  getTokenCache: () => Map<string, AccountLeaseTokenData>;
  logger: AccountLeaseHydrationLogger;
  persistTokenState?: (
    accountId: string,
    tokenData: AccountLeaseTokenData,
    expected: TokenIdentity,
  ) => Promise<void>;
  recoveryJournal?: OAuthRecoveryJournal;
}

type TokenIdentity = Pick<
  AccountLeaseTokenData,
  'access_token' | 'refresh_token' | 'oauth_client_key'
>;

interface HydrateSelectedTokenRequest {
  accountId: string;
  tokenData: AccountLeaseTokenData;
  nowSeconds: number;
  fallbackProjectId: string;
}

export class AccountLeaseHydrationPolicy {
  private readonly refreshLocks = new Map<string, Promise<void>>();
  private readonly projectIdLocks = new Map<string, Promise<string | undefined>>();
  private readonly persistenceTails = new Map<string, Promise<void>>();
  private readonly failedPersistence = new Map<
    string,
    { token: AccountLeaseTokenData; expected: TokenIdentity; recoveryName?: string }
  >();

  constructor(private readonly options: AccountLeaseHydrationPolicyOptions) {}

  async hydrateSelectedToken(request: HydrateSelectedTokenRequest): Promise<string> {
    const { accountId, tokenData, nowSeconds, fallbackProjectId } = request;

    await this.refreshSelectedTokenIfNeeded(accountId, tokenData, nowSeconds);

    if (normalizeProjectId(tokenData.project_id) === undefined) {
      tokenData.project_id = undefined;
    }
    let effectiveProjectId = tokenData.project_id;

    if (!effectiveProjectId) {
      effectiveProjectId = await this.resolveProjectIdWithLock(accountId, tokenData);
    }

    if (!effectiveProjectId) {
      effectiveProjectId = fallbackProjectId;
      this.options.logger.warn(
        `Using non-persistent fallback project ID for ${tokenData.email}: ${fallbackProjectId}`,
      );
    }

    return effectiveProjectId;
  }

  async refreshSelectedTokenIfNeeded(
    accountId: string,
    tokenData: AccountLeaseTokenData,
    nowSeconds: number,
  ): Promise<void> {
    if (nowSeconds < tokenData.expiry_timestamp - 300) {
      return;
    }

    await this.runAccountLock(this.refreshLocks, accountId, () =>
      this.refreshSelectedTokenLocked(accountId, tokenData, nowSeconds),
    );
    this.syncTokenDataFromCache(accountId, tokenData);
  }

  async refreshSelectedTokenLocked(
    accountId: string,
    tokenData: AccountLeaseTokenData,
    nowSeconds: number,
  ): Promise<void> {
    const tokenCache = this.options.getTokenCache();
    const latestToken = tokenCache.get(accountId);
    if (latestToken && nowSeconds < latestToken.expiry_timestamp - 300) {
      Object.assign(tokenData, latestToken);
      this.options.logger.debug(
        `Access token already refreshed by another request for ${tokenData.email}`,
      );
      return;
    }

    const tokenToRefresh = latestToken ?? tokenData;
    const originalRefreshToken = tokenToRefresh.refresh_token;
    const originalAccessToken = tokenToRefresh.access_token;
    const originalClientKey = tokenToRefresh.oauth_client_key;
    this.options.logger.log(`Access token near expiry for ${tokenToRefresh.email}; refreshing`);
    try {
      const refreshedToken = await this.options.upstream.refreshAccessToken(
        accountId,
        tokenToRefresh.refresh_token,
        tokenToRefresh.upstream_proxy_url,
        tokenToRefresh.oauth_client_key,
        tokenToRefresh.oauth_health ? { oauth: tokenToRefresh.oauth_health } : undefined,
      );
      const currentToken = tokenCache.get(accountId);
      if (
        !currentToken ||
        currentToken.refresh_token !== originalRefreshToken ||
        currentToken.access_token !== originalAccessToken ||
        currentToken.oauth_client_key !== originalClientKey
      ) {
        return;
      }
      currentToken.access_token = refreshedToken.access_token;
      currentToken.refresh_token = refreshedToken.refresh_token ?? currentToken.refresh_token;
      currentToken.id_token = refreshedToken.id_token ?? currentToken.id_token;
      currentToken.expires_in = refreshedToken.expires_in;
      currentToken.expiry_timestamp = nowSeconds + refreshedToken.expires_in;
      currentToken.oauth_client_key = this.normalizeRefreshedOauthClientKey(
        currentToken,
        refreshedToken.oauth_client_key,
      );
      Object.assign(tokenData, currentToken);
      let recoveryName: string | undefined;
      if (
        this.options.recoveryJournal &&
        (currentToken.refresh_token !== originalRefreshToken ||
          currentToken.access_token !== originalAccessToken)
      ) {
        try {
          recoveryName = await this.options.recoveryJournal.append({
            version: 1,
            accountId,
            expected: {
              access_token: originalAccessToken,
              refresh_token: originalRefreshToken,
              oauth_client_key: originalClientKey,
            },
            token: {
              access_token: currentToken.access_token,
              refresh_token: currentToken.refresh_token,
              expires_in: currentToken.expires_in,
              expiry_timestamp: currentToken.expiry_timestamp,
              token_type: currentToken.token_type,
              email: currentToken.email,
              project_id: currentToken.project_id,
              oauth_client_key: currentToken.oauth_client_key,
              session_id: currentToken.session_id,
              id_token: currentToken.id_token,
              upstream_proxy_url: currentToken.upstream_proxy_url,
            },
          });
        } catch (journalError) {
          this.options.logger.error(
            `Failed to write OAuth recovery record for ${currentToken.email}`,
            journalError,
          );
        }
      }
      this.enqueueTokenStatePersistence(
        accountId,
        currentToken,
        {
          access_token: originalAccessToken,
          refresh_token: originalRefreshToken,
          oauth_client_key: originalClientKey,
        },
        recoveryName,
      );
      this.options.logger.log(`Access token refreshed for ${currentToken.email}`);
    } catch (error) {
      this.options.logger.error(
        `Failed to refresh access token for ${tokenToRefresh.email}`,
        error,
      );
      if (
        error instanceof CloudAccountRefreshBlockedError ||
        (error instanceof OAuthTokenRefreshError && error.code === 'invalid_grant')
      ) {
        if (
          error instanceof CloudAccountRefreshBlockedError &&
          tokenCache.get(accountId) === tokenToRefresh
        ) {
          tokenCache.delete(accountId);
        }
        throw new AccountLeaseRefreshRejectedError(accountId, 'invalid_grant', error);
      }
      throw error;
    }
  }

  async resolveProjectIdWithLock(
    accountId: string,
    tokenData: AccountLeaseTokenData,
  ): Promise<string | undefined> {
    const existingProjectId = normalizeProjectId(
      this.options.getTokenCache().get(accountId)?.project_id,
    );
    if (existingProjectId) {
      tokenData.project_id = existingProjectId;
      return existingProjectId;
    }

    const projectId = await this.runAccountLock(this.projectIdLocks, accountId, () =>
      this.resolveProjectIdLocked(accountId, tokenData),
    );
    if (projectId) {
      tokenData.project_id = projectId;
    }

    return projectId;
  }

  async runAccountLock<T>(
    locks: Map<string, Promise<T>>,
    accountId: string,
    createPromise: () => Promise<T>,
  ): Promise<T> {
    const existingPromise = locks.get(accountId);
    if (existingPromise) {
      return existingPromise;
    }

    const promise = createPromise();
    locks.set(accountId, promise);
    try {
      return await promise;
    } finally {
      if (locks.get(accountId) === promise) {
        locks.delete(accountId);
      }
    }
  }

  syncTokenDataFromCache(accountId: string, tokenData: AccountLeaseTokenData): void {
    const latestToken = this.options.getTokenCache().get(accountId);
    if (latestToken) {
      Object.assign(tokenData, latestToken);
    }
  }

  async resolveProjectIdLocked(
    accountId: string,
    tokenData: AccountLeaseTokenData,
  ): Promise<string | undefined> {
    const tokenCache = this.options.getTokenCache();
    const latestToken = tokenCache.get(accountId) ?? tokenData;
    const existingProjectId = normalizeProjectId(latestToken.project_id);
    if (existingProjectId) {
      tokenData.project_id = existingProjectId;
      return existingProjectId;
    }

    try {
      const fetchedProjectId = await this.options.upstream.fetchProjectId(
        latestToken.access_token,
        latestToken.upstream_proxy_url,
      );
      if (tokenCache.get(accountId) !== latestToken) {
        return undefined;
      }
      const normalizedProjectId = normalizeProjectId(fetchedProjectId);
      if (normalizedProjectId) {
        latestToken.project_id = normalizedProjectId;
        tokenData.project_id = normalizedProjectId;
        tokenCache.set(accountId, latestToken);
        this.enqueueTokenStatePersistence(accountId, latestToken);
        this.options.logger.log(
          `Resolved project ID for ${latestToken.email}: ${normalizedProjectId}`,
        );
        return normalizedProjectId;
      }

      this.options.logger.warn(
        `Project ID unavailable for ${latestToken.email}; continuing without project context`,
      );
    } catch (error) {
      this.options.logger.warn(`Unable to resolve project ID for ${latestToken.email}`, error);
    }

    return undefined;
  }

  async persistTokenState(
    accountId: string,
    tokenData: AccountLeaseTokenData,
    expected: TokenIdentity = tokenData,
  ): Promise<void> {
    let initialProjectId: string | undefined;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const persistedAccount = await this.options.accountStore.getAccount(accountId);
      if (
        !persistedAccount?.token ||
        persistedAccount.token.access_token !== expected.access_token ||
        persistedAccount.token.refresh_token !== expected.refresh_token ||
        normalizeClientKey(persistedAccount.token.oauth_client_key) !==
          normalizeClientKey(expected.oauth_client_key)
      ) {
        return;
      }
      if (attempt === 0) {
        initialProjectId = persistedAccount.token.project_id;
      }
      const updatedToken = {
        ...persistedAccount.token,
        access_token: tokenData.access_token,
        refresh_token: tokenData.refresh_token,
        id_token: tokenData.id_token ?? persistedAccount.token.id_token,
        expires_in: tokenData.expires_in,
        expiry_timestamp: tokenData.expiry_timestamp,
        project_id:
          attempt > 0 && persistedAccount.token.project_id !== initialProjectId
            ? persistedAccount.token.project_id
            : (tokenData.project_id ?? persistedAccount.token.project_id),
        oauth_client_key:
          tokenData.oauth_client_key ??
          normalizeClientKey(persistedAccount.token.oauth_client_key) ??
          persistedAccount.token.oauth_client_key,
        session_id: tokenData.session_id ?? persistedAccount.token.session_id,
        upstream_proxy_url:
          tokenData.upstream_proxy_url ?? persistedAccount.token.upstream_proxy_url,
      };
      const saved = await this.options.accountStore.compareAndUpdateToken(
        accountId,
        persistedAccount.token,
        updatedToken,
      );
      if (saved) {
        return;
      }
    }
    throw new Error(
      `Token state was not persisted for ${accountId}: account changed during update`,
    );
  }

  normalizeRefreshedOauthClientKey(
    currentToken: { oauth_client_key?: string; project_id?: string },
    refreshedClientKey?: string,
  ): string | undefined {
    return this.options.upstream.normalizeRefreshedOAuthClientKey(currentToken, refreshedClientKey);
  }

  async drainBackgroundPersistence(): Promise<void> {
    while (this.persistenceTails.size > 0) {
      await Promise.all(this.persistenceTails.values());
    }
  }

  async retryFailedPersistence(): Promise<void> {
    await this.drainBackgroundPersistence();
    for (const [accountId, pending] of this.failedPersistence) {
      await this.saveTokenState(accountId, pending.token, pending.expected, pending.recoveryName);
      if (this.failedPersistence.get(accountId) === pending) {
        this.failedPersistence.delete(accountId);
      }
    }
  }

  private async saveTokenState(
    accountId: string,
    tokenData: AccountLeaseTokenData,
    expected: TokenIdentity,
    recoveryName?: string,
  ): Promise<void> {
    if (this.options.persistTokenState) {
      await this.options.persistTokenState(accountId, tokenData, expected);
    } else {
      await this.persistTokenState(accountId, tokenData, expected);
    }

    if (recoveryName && this.options.recoveryJournal) {
      await this.options.recoveryJournal.remove(recoveryName).catch((err) => {
        this.options.logger.warn(`Failed to remove OAuth recovery record ${recoveryName}`, err);
      });
    }
  }

  private enqueueTokenStatePersistence(
    accountId: string,
    tokenData: AccountLeaseTokenData,
    expected: TokenIdentity = tokenData,
    recoveryName?: string,
  ): void {
    const snapshot = { ...tokenData };
    const expectedSnapshot = {
      access_token: expected.access_token,
      refresh_token: expected.refresh_token,
      oauth_client_key: expected.oauth_client_key,
    };
    const previous = this.persistenceTails.get(accountId) ?? Promise.resolve();
    // Account-store reads and writes contain synchronous SQLite work. Starting on the next
    // event-loop turn keeps it outside lease fulfillment, while the per-account tail prevents
    // an older refresh snapshot from overwriting a later project/token update.
    const task = previous
      .then(() => new Promise<void>((resolve) => setImmediate(resolve)))
      .then(() => this.saveTokenState(accountId, snapshot, expectedSnapshot, recoveryName))
      .catch((error: unknown) => {
        const earlier = this.failedPersistence.get(accountId);
        const chained =
          earlier &&
          earlier.token.access_token === expectedSnapshot.access_token &&
          earlier.token.refresh_token === expectedSnapshot.refresh_token &&
          normalizeClientKey(earlier.token.oauth_client_key) ===
            normalizeClientKey(expectedSnapshot.oauth_client_key);
        this.failedPersistence.set(accountId, {
          token: snapshot,
          expected: chained ? earlier.expected : expectedSnapshot,
          recoveryName: recoveryName ?? earlier?.recoveryName,
        });
        this.options.logger.error(`Failed to persist token state for ${accountId}`, error);
      });

    this.persistenceTails.set(accountId, task);
    task.finally(() => {
      if (this.persistenceTails.get(accountId) === task) {
        this.persistenceTails.delete(accountId);
      }
    });
  }
}

export class AccountLeaseRefreshRejectedError extends Error {
  constructor(
    readonly accountId: string,
    readonly reason: 'invalid_grant',
    options?: ErrorOptions,
  ) {
    super(`Account ${accountId} refresh rejected: ${reason}`, options);
    this.name = 'AccountLeaseRefreshRejectedError';
  }
}
