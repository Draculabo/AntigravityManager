import type { Logger } from '@nestjs/common';
import type { AccountLeaseAccountStore, AccountLeaseUpstream } from '../interfaces/account-lease-adapters';
import {
  type AccountLeaseTokenData,
  normalizeClientKey,
  normalizeProjectId,
} from '../interfaces/account-lease-token-types';

type AccountLeaseHydrationLogger = Pick<Logger, 'debug' | 'error' | 'log' | 'warn'>;

interface AccountLeaseHydrationPolicyOptions {
  accountStore: AccountLeaseAccountStore;
  upstream: AccountLeaseUpstream;
  getTokenCache: () => Map<string, AccountLeaseTokenData>;
  logger: AccountLeaseHydrationLogger;
  persistTokenState?: (accountId: string, tokenData: AccountLeaseTokenData) => Promise<void>;
}

interface HydrateSelectedTokenRequest {
  accountId: string;
  tokenData: AccountLeaseTokenData;
  nowSeconds: number;
  fallbackProjectId: string;
}

export class AccountLeaseHydrationPolicy {
  private readonly refreshLocks = new Map<string, Promise<void>>();
  private readonly projectIdLocks = new Map<string, Promise<string | undefined>>();

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
    this.options.logger.log(`Access token near expiry for ${tokenToRefresh.email}; refreshing`);
    try {
      const refreshedToken = await this.options.upstream.refreshAccessToken(
        tokenToRefresh.refresh_token,
        tokenToRefresh.upstream_proxy_url,
        tokenToRefresh.oauth_client_key,
      );
      tokenToRefresh.access_token = refreshedToken.access_token;
      tokenToRefresh.refresh_token = refreshedToken.refresh_token ?? tokenToRefresh.refresh_token;
      tokenToRefresh.id_token = refreshedToken.id_token ?? tokenToRefresh.id_token;
      tokenToRefresh.expires_in = refreshedToken.expires_in;
      tokenToRefresh.expiry_timestamp = nowSeconds + refreshedToken.expires_in;
      tokenToRefresh.oauth_client_key = this.normalizeRefreshedOauthClientKey(
        tokenToRefresh,
        refreshedToken.oauth_client_key,
      );
      Object.assign(tokenData, tokenToRefresh);
      await this.saveTokenState(accountId, tokenToRefresh);
      tokenCache.set(accountId, tokenToRefresh);
      this.options.logger.log(`Access token refreshed for ${tokenToRefresh.email}`);
    } catch (error) {
      this.options.logger.error(
        `Failed to refresh access token for ${tokenToRefresh.email}`,
        error,
      );
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
      const normalizedProjectId = normalizeProjectId(fetchedProjectId);
      if (normalizedProjectId) {
        latestToken.project_id = normalizedProjectId;
        tokenData.project_id = normalizedProjectId;
        await this.saveTokenState(accountId, latestToken);
        tokenCache.set(accountId, latestToken);
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

  async persistTokenState(accountId: string, tokenData: AccountLeaseTokenData): Promise<void> {
    try {
      const persistedAccount = await this.options.accountStore.getAccount(accountId);
      if (persistedAccount?.token) {
        const updatedToken = {
          ...persistedAccount.token,
          access_token: tokenData.access_token,
          refresh_token: tokenData.refresh_token,
          id_token: tokenData.id_token ?? persistedAccount.token.id_token,
          expires_in: tokenData.expires_in,
          expiry_timestamp: tokenData.expiry_timestamp,
          project_id: tokenData.project_id ?? persistedAccount.token.project_id,
          oauth_client_key:
            tokenData.oauth_client_key ??
            normalizeClientKey(persistedAccount.token.oauth_client_key) ??
            persistedAccount.token.oauth_client_key,
          session_id: tokenData.session_id ?? persistedAccount.token.session_id,
          upstream_proxy_url:
            tokenData.upstream_proxy_url ?? persistedAccount.token.upstream_proxy_url,
        };
        await this.options.accountStore.updateToken(accountId, updatedToken);
      }
    } catch (error) {
      this.options.logger.error('Failed to persist token state to database', error);
    }
  }

  normalizeRefreshedOauthClientKey(
    currentToken: { oauth_client_key?: string; project_id?: string },
    refreshedClientKey?: string,
  ): string | undefined {
    return this.options.upstream.normalizeRefreshedOAuthClientKey(currentToken, refreshedClientKey);
  }

  private async saveTokenState(accountId: string, tokenData: AccountLeaseTokenData): Promise<void> {
    if (this.options.persistTokenState) {
      await this.options.persistTokenState(accountId, tokenData);
      return;
    }

    await this.persistTokenState(accountId, tokenData);
  }
}
