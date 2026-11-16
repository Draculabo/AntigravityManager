import type { Logger } from '@nestjs/common';
import type {
  AccountLeaseAccountStore,
  AccountLeaseUpstream,
} from '../interfaces/account-lease-adapters';
import {
  type AccountLeaseTokenData,
  normalizeClientKey,
} from '../interfaces/account-lease-token-types';
import { CloudAccountRefreshBlockedError } from '@/modules/cloud-account/services/CloudAccountRefreshService';
import { OAuthTokenRefreshError } from '@/modules/cloud-account/services/GoogleAPIService';
import type { OAuthRecoveryJournal } from '@/modules/cloud-account/persistence/oauth-recovery-journal';
import { AccountLeaseProjectPolicy } from './account-lease-project.policy';
import { captureLeaseWriteGuard, leaseStoredContext } from './account-lease-writeback';

type AccountLeaseHydrationLogger = Pick<Logger, 'debug' | 'error' | 'log' | 'warn'>;

interface AccountLeaseHydrationPolicyOptions {
  accountStore: AccountLeaseAccountStore;
  upstream: AccountLeaseUpstream;
  getTokenCache: () => Map<string, AccountLeaseTokenData>;
  logger: AccountLeaseHydrationLogger;
  /** An injected writer rechecks the guard after its final awaited read, before writing. */
  persistTokenState?: (
    accountId: string,
    tokenData: AccountLeaseTokenData,
    expected: TokenIdentity,
    isCurrent?: () => boolean,
  ) => Promise<boolean | void>;
  recoveryJournal?: OAuthRecoveryJournal;
}

export type TokenIdentity = Pick<
  AccountLeaseTokenData,
  'access_token' | 'refresh_token' | 'oauth_client_key'
>;

interface HydrateSelectedTokenRequest {
  accountId: string;
  tokenData: AccountLeaseTokenData;
  nowSeconds: number;
  fallbackProjectId: string;
  control?: AccountLeaseRefreshControl;
}

interface RefreshOperation {
  isCurrent(): boolean;
  pending: Promise<void>;
}

export interface AccountLeaseRefreshControl {
  signal: AbortSignal;
  assertCurrent: () => void;
}

export class AccountLeaseHydrationPolicy {
  private readonly refreshOperations = new WeakMap<AccountLeaseTokenData, RefreshOperation>();
  private readonly projects: AccountLeaseProjectPolicy;
  private readonly persistenceTails = new Map<string, Promise<void>>();
  private readonly failedPersistence = new Map<
    string,
    { token: AccountLeaseTokenData; expected: TokenIdentity; recoveryName?: string }
  >();

  constructor(private readonly options: AccountLeaseHydrationPolicyOptions) {
    this.projects = new AccountLeaseProjectPolicy({
      upstream: options.upstream,
      getTokenCache: options.getTokenCache,
      logger: options.logger,
      persist: (accountId, token, isCurrent) =>
        this.enqueueTokenStatePersistence(accountId, token, isCurrent),
    });
  }

  invalidateProject(accountId: string): void {
    const token = this.options.getTokenCache().get(accountId);
    if (token) {
      this.projects.invalidate(token);
    }
  }

  async hydrateSelectedToken(request: HydrateSelectedTokenRequest): Promise<string> {
    const { accountId, tokenData, nowSeconds, fallbackProjectId } = request;

    if (request.control) {
      await this.refreshSelectedTokenIfNeeded(accountId, tokenData, nowSeconds, request.control);
    } else {
      await this.refreshSelectedTokenIfNeeded(accountId, tokenData, nowSeconds);
    }
    request.control?.assertCurrent();
    const isCurrent = this.captureRefreshContext(accountId, tokenData);
    this.assertCurrent(accountId, tokenData, isCurrent);
    let effectiveProjectId = request.control
      ? await this.resolveProjectIdWithLock(accountId, tokenData, request.control)
      : await this.resolveProjectIdWithLock(accountId, tokenData);
    request.control?.assertCurrent();
    this.assertCurrent(accountId, tokenData, isCurrent);

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
    control?: AccountLeaseRefreshControl,
  ): Promise<void> {
    const isCurrent = this.captureRefreshContext(accountId, tokenData);
    control?.assertCurrent();
    this.assertCurrent(accountId, tokenData, isCurrent);
    if (nowSeconds < tokenData.expiry_timestamp - 300) {
      return;
    }
    const existing = this.refreshOperations.get(tokenData);
    if (existing?.isCurrent()) {
      return existing.pending;
    }
    const operation: RefreshOperation = {
      isCurrent,
      pending: this.performRefresh(accountId, tokenData, nowSeconds, isCurrent, control),
    };
    this.refreshOperations.set(tokenData, operation);
    try {
      await operation.pending;
    } finally {
      if (this.refreshOperations.get(tokenData) === operation) {
        this.refreshOperations.delete(tokenData);
      }
    }
  }

  private async performRefresh(
    accountId: string,
    tokenToRefresh: AccountLeaseTokenData,
    nowSeconds: number,
    isCurrent: () => boolean,
    control?: AccountLeaseRefreshControl,
  ): Promise<void> {
    const tokenCache = this.options.getTokenCache();
    const expected: TokenIdentity = {
      access_token: tokenToRefresh.access_token,
      refresh_token: tokenToRefresh.refresh_token,
      oauth_client_key: tokenToRefresh.oauth_client_key,
    };
    const { email, upstream_proxy_url, stored_context } = tokenToRefresh;
    const lifecycleGeneration = stored_context?.account.lifecycle_generation;
    const currentToken = () => {
      const latest = tokenCache.get(accountId);
      if (
        !latest ||
        latest.access_token !== expected.access_token ||
        latest.refresh_token !== expected.refresh_token ||
        latest.oauth_client_key !== expected.oauth_client_key ||
        latest.email !== email ||
        latest.upstream_proxy_url !== upstream_proxy_url ||
        latest.stored_context?.account.lifecycle_generation !== lifecycleGeneration ||
        latest.oauth_health?.refresh_blocked ||
        latest.service_disabled
      ) {
        throw new AccountLeaseStaleTokenError(accountId);
      }
      if (control) {
        this.assertCurrent(accountId, tokenToRefresh, executionCurrent);
      }
      return latest;
    };
    const executionCurrent = () => {
      control?.signal.throwIfAborted();
      control?.assertCurrent();
      return isCurrent() && tokenToRefresh.access_token === expected.access_token;
    };
    this.options.logger.log(`Access token near expiry for account ${accountId}; refreshing`);
    let persistenceStarted = false;

    try {
      const args: Parameters<AccountLeaseUpstream['refreshAccessToken']> = [
        accountId,
        tokenToRefresh.refresh_token,
        tokenToRefresh.upstream_proxy_url,
        tokenToRefresh.oauth_client_key,
        tokenToRefresh.oauth_health ? { oauth: tokenToRefresh.oauth_health } : undefined,
      ];
      if (control) {
        args.push({
          signal: control.signal,
          assertCurrent: () => this.assertCurrent(accountId, tokenToRefresh, executionCurrent),
        });
      }
      const refreshed = await this.options.upstream.refreshAccessToken(...args);
      currentToken();
      const nextToken = {
        ...tokenToRefresh,
        access_token: refreshed.access_token,
        refresh_token: refreshed.refresh_token ?? tokenToRefresh.refresh_token,
        id_token: refreshed.id_token ?? tokenToRefresh.id_token,
        expires_in: refreshed.expires_in,
        expiry_timestamp:
          (control ? Math.floor(Date.now() / 1000) : nowSeconds) + refreshed.expires_in,
        oauth_client_key: this.normalizeRefreshedOauthClientKey(
          tokenToRefresh,
          refreshed.oauth_client_key,
        ),
      };
      const recoveryName = await this.recordRefreshRecovery(accountId, nextToken, expected);
      const latest = currentToken();
      if (control) {
        persistenceStarted = true;
        await this.enqueueTokenStatePersistence(
          accountId,
          nextToken,
          executionCurrent,
          expected,
          recoveryName,
          true,
        );
        this.assertCurrent(accountId, tokenToRefresh, executionCurrent);
      }
      Object.assign(latest, {
        access_token: nextToken.access_token,
        refresh_token: nextToken.refresh_token,
        id_token: nextToken.id_token,
        expires_in: nextToken.expires_in,
        expiry_timestamp: nextToken.expiry_timestamp,
        oauth_client_key: nextToken.oauth_client_key,
      });
      if (!control) {
        const context = this.captureRefreshContext(accountId, latest);
        this.enqueueTokenStatePersistence(
          accountId,
          latest,
          () => context() && latest.access_token === nextToken.access_token,
          expected,
          recoveryName,
        );
      }
      this.options.logger.log(`Access token refreshed for account ${accountId}`);
    } catch (error) {
      if (control && persistenceStarted && isCurrent()) {
        this.invalidateProject(accountId);
        tokenCache.delete(accountId);
      }
      this.options.logger.error(`Failed to refresh access token for account ${accountId}`, error);
      if (
        error instanceof CloudAccountRefreshBlockedError ||
        (error instanceof OAuthTokenRefreshError && error.code === 'invalid_grant')
      ) {
        if (error instanceof CloudAccountRefreshBlockedError && isCurrent()) {
          this.invalidateProject(accountId);
          tokenCache.delete(accountId);
        }
        throw new AccountLeaseRefreshRejectedError(accountId, 'invalid_grant', { cause: error });
      }
      throw error;
    }
  }

  private async recordRefreshRecovery(
    accountId: string,
    token: AccountLeaseTokenData,
    expected: TokenIdentity,
  ): Promise<string | undefined> {
    const journal = this.options.recoveryJournal;
    if (
      !journal ||
      (token.access_token === expected.access_token &&
        token.refresh_token === expected.refresh_token)
    ) {
      return undefined;
    }
    try {
      return await journal.append({
        version: 1,
        accountId,
        expected,
        token: {
          access_token: token.access_token,
          refresh_token: token.refresh_token,
          expires_in: token.expires_in,
          expiry_timestamp: token.expiry_timestamp,
          token_type: token.token_type,
          email: token.email,
          project_id: token.project_id,
          oauth_client_key: token.oauth_client_key,
          session_id: token.session_id,
          id_token: token.id_token,
          upstream_proxy_url: token.upstream_proxy_url,
        },
      });
    } catch (error) {
      this.options.logger.error(
        `Failed to write OAuth recovery record for account ${accountId}`,
        error,
      );
      return undefined;
    }
  }

  private captureRefreshContext(accountId: string, token: AccountLeaseTokenData): () => boolean {
    const { refresh_token, oauth_client_key, upstream_proxy_url, email } = token;
    const lifecycle = token.stored_context?.account.lifecycle_generation;
    return () =>
      this.options.getTokenCache().get(accountId) === token &&
      token.refresh_token === refresh_token &&
      token.oauth_client_key === oauth_client_key &&
      token.upstream_proxy_url === upstream_proxy_url &&
      token.email === email &&
      token.stored_context?.account.lifecycle_generation === lifecycle;
  }

  private assertCurrent(
    accountId: string,
    token: AccountLeaseTokenData,
    isCurrent: () => boolean,
  ): void {
    if (!isCurrent() || token.oauth_health?.refresh_blocked || token.service_disabled) {
      throw new AccountLeaseStaleTokenError(accountId);
    }
  }

  async resolveProjectIdWithLock(
    accountId: string,
    tokenData: AccountLeaseTokenData,
    control?: AccountLeaseRefreshControl,
  ): Promise<string | undefined> {
    return control
      ? this.projects.resolve(accountId, tokenData, control)
      : this.projects.resolve(accountId, tokenData);
  }

  async persistTokenState(
    accountId: string,
    tokenData: AccountLeaseTokenData,
    expected: TokenIdentity = tokenData,
    isCurrent?: () => boolean,
  ): Promise<boolean> {
    let initialProjectId: string | undefined;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const account = await this.options.accountStore.getAccount(accountId);
      const storedContext = tokenData.stored_context?.account;
      if (
        (isCurrent && !isCurrent()) ||
        !account ||
        account.token.access_token !== expected.access_token ||
        account.token.refresh_token !== expected.refresh_token ||
        normalizeClientKey(account.token.oauth_client_key) !==
          normalizeClientKey(expected.oauth_client_key) ||
        (storedContext &&
          (storedContext.lifecycle_generation !== account.lifecycle_generation ||
            storedContext.created_at !== account.created_at ||
            storedContext.email !== account.email ||
            storedContext.proxy_url !== account.proxy_url))
      ) {
        return false;
      }
      if (attempt === 0) {
        initialProjectId = account.token.project_id;
      }
      const guard = captureLeaseWriteGuard(
        { ...tokenData, stored_context: leaseStoredContext(account) },
        isCurrent ?? (() => true),
      );
      const updatedToken = {
        ...account.token,
        access_token: tokenData.access_token,
        refresh_token: tokenData.refresh_token,
        id_token: tokenData.id_token ?? account.token.id_token,
        expires_in: tokenData.expires_in,
        expiry_timestamp: tokenData.expiry_timestamp,
        project_id:
          attempt > 0 && account.token.project_id !== initialProjectId
            ? account.token.project_id
            : (tokenData.project_id ?? account.token.project_id),
        oauth_client_key:
          tokenData.oauth_client_key ??
          normalizeClientKey(account.token.oauth_client_key) ??
          account.token.oauth_client_key,
        session_id: tokenData.session_id ?? account.token.session_id,
        upstream_proxy_url: tokenData.upstream_proxy_url ?? account.token.upstream_proxy_url,
      };
      const saved = await this.options.accountStore.compareAndUpdateToken(
        accountId,
        account.token,
        updatedToken,
        guard,
      );
      if (saved) {
        if (tokenData.stored_context) {
          const current = await this.options.accountStore.getAccount(accountId);
          captureLeaseWriteGuard(
            {
              ...tokenData,
              stored_context: leaseStoredContext({ ...account, token: updatedToken }),
            },
            isCurrent ?? (() => true),
          )(current);
          if (!current) {
            throw new AccountLeaseStaleTokenError(accountId);
          }
          tokenData.stored_context.account = leaseStoredContext(current).account;
        }
        return true;
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
    isCurrent?: () => boolean,
  ): Promise<boolean> {
    const saved = this.options.persistTokenState
      ? await this.options.persistTokenState(accountId, tokenData, expected, isCurrent)
      : await this.persistTokenState(accountId, tokenData, expected, isCurrent);
    if (saved !== false && recoveryName && this.options.recoveryJournal) {
      await this.options.recoveryJournal.remove(recoveryName).catch((error) => {
        this.options.logger.warn(`Failed to remove OAuth recovery record ${recoveryName}`, error);
      });
    }
    return saved !== false;
  }

  private enqueueTokenStatePersistence(
    accountId: string,
    tokenData: AccountLeaseTokenData,
    isCurrent?: () => boolean,
    expected: TokenIdentity = tokenData,
    recoveryName?: string,
    strict = false,
  ): Promise<void> {
    const snapshot = { ...tokenData };
    const expectedSnapshot: TokenIdentity = {
      access_token: expected.access_token,
      refresh_token: expected.refresh_token,
      oauth_client_key: expected.oauth_client_key,
    };
    const previous = this.persistenceTails.get(accountId) ?? Promise.resolve();
    const write = previous
      .then(() => new Promise<void>((resolve) => setImmediate(resolve)))
      .then(async () => {
        const saved =
          (!isCurrent || isCurrent()) &&
          (await this.saveTokenState(
            accountId,
            snapshot,
            expectedSnapshot,
            recoveryName,
            isCurrent,
          ));
        if (!saved && strict) {
          throw new AccountLeaseStaleTokenError(accountId);
        }
      });
    const task = write.catch((error: unknown) => {
      if (!strict && (!isCurrent || isCurrent())) {
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
      }
      this.options.logger.error(`Failed to persist token state for ${accountId}`, error);
    });
    this.persistenceTails.set(accountId, task);
    void task.finally(() => {
      if (this.persistenceTails.get(accountId) === task) {
        this.persistenceTails.delete(accountId);
      }
    });
    return strict ? write : task;
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

export class AccountLeaseStaleTokenError extends Error {
  constructor(accountId: string, options?: ErrorOptions) {
    super(`Account ${accountId} changed during lease hydration`, options);
    this.name = 'AccountLeaseStaleTokenError';
  }
}
