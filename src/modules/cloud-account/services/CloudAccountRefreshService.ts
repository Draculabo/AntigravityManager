import type { CloudAccount } from '@/modules/cloud-account/types';
import {
  CloudAccountHealthService,
  evictAccountFromActiveLeaseCache,
  syncAccountOAuthHealthToActiveLeaseCache,
} from './CloudAccountHealthService';
import { GoogleAPIService, OAuthTokenRefreshError, type TokenResponse } from './GoogleAPIService';

export interface CloudAccountRefreshRequest {
  accountId: string;
  refreshToken: string;
  proxyUrl?: string;
  oauthClientKey?: string;
  health?: CloudAccount['health'];
  signal?: AbortSignal;
}

/**
 * Owns account-level refresh revocation state. The provider client performs the
 * short same-request retry; this service requires two failed refresh operations
 * before durably removing an account from automatic selection.
 */
export class CloudAccountRefreshService {
  private static readonly operationLocks = new Map<string, Promise<void>>();

  static async refreshAccessToken(request: CloudAccountRefreshRequest): Promise<TokenResponse> {
    return this.runAccountOperation(request.accountId, () =>
      this.refreshAccessTokenLocked(request),
    );
  }

  static async clearFailureState(accountId: string): Promise<void> {
    await this.runAccountOperation(accountId, async () => {
      const health = await CloudAccountHealthService.getHealth(accountId);
      if (health?.oauth) {
        await CloudAccountHealthService.mutateHealth(accountId, (currentHealth) =>
          currentHealth?.validation ? { validation: currentHealth.validation } : undefined,
        );
      }

      const { reloadNestServerAccountLeaseCache } = await import('@/server/main');
      await reloadNestServerAccountLeaseCache();
    });
  }

  static resetStateForTesting(): void {
    this.operationLocks.clear();
    CloudAccountHealthService.resetStateForTesting();
  }

  private static async refreshAccessTokenLocked(
    request: CloudAccountRefreshRequest,
  ): Promise<TokenResponse> {
    // request.health is only a transport hint. The persisted value is authoritative
    // because another caller may have changed the account while this request waited.
    const effectiveHealth = await CloudAccountHealthService.getHealth(request.accountId);
    if (effectiveHealth?.oauth?.refresh_blocked) {
      throw new CloudAccountRefreshBlockedError(request.accountId);
    }

    try {
      const refreshedToken = request.signal
        ? await GoogleAPIService.refreshAccessToken(
            request.refreshToken,
            request.proxyUrl,
            request.oauthClientKey,
            request.signal,
          )
        : await GoogleAPIService.refreshAccessToken(
            request.refreshToken,
            request.proxyUrl,
            request.oauthClientKey,
          );
      if (effectiveHealth?.oauth) {
        const clearedHealth = await CloudAccountHealthService.mutateHealth(
          request.accountId,
          (currentHealth) =>
            currentHealth?.validation ? { validation: currentHealth.validation } : undefined,
        );
        await syncAccountOAuthHealthToActiveLeaseCache(request.accountId, clearedHealth?.oauth);
      }
      return refreshedToken;
    } catch (error) {
      if (!(error instanceof OAuthTokenRefreshError) || error.code !== 'invalid_grant') {
        throw error;
      }

      const failureAt = Date.now();
      const updatedHealth = await CloudAccountHealthService.mutateHealth(
        request.accountId,
        (currentHealth) => {
          const failureCount = Math.min(2, (currentHealth?.oauth?.invalid_grant_count ?? 0) + 1);
          return {
            ...currentHealth,
            oauth: {
              refresh_blocked: failureCount >= 2,
              invalid_grant_count: failureCount,
              invalid_grant_last_at_ms: failureAt,
              blocked_at_ms: failureCount >= 2 ? failureAt : undefined,
              reason: 'invalid_grant',
            },
          };
        },
      );
      if (!updatedHealth?.oauth?.refresh_blocked) {
        await syncAccountOAuthHealthToActiveLeaseCache(request.accountId, updatedHealth?.oauth);
        throw error;
      }

      await evictAccountFromActiveLeaseCache(request.accountId);
      throw new CloudAccountRefreshBlockedError(request.accountId, error);
    }
  }

  private static async runAccountOperation<T>(
    accountId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previousOperation = this.operationLocks.get(accountId) ?? Promise.resolve();
    const operationPromise = previousOperation.catch(() => undefined).then(operation);
    const operationTail = operationPromise.then(
      () => undefined,
      () => undefined,
    );
    this.operationLocks.set(accountId, operationTail);

    try {
      return await operationPromise;
    } finally {
      if (this.operationLocks.get(accountId) === operationTail) {
        this.operationLocks.delete(accountId);
      }
    }
  }
}

export class CloudAccountRefreshBlockedError extends Error {
  constructor(
    readonly accountId: string,
    options?: ErrorOptions,
  ) {
    super(`Automatic token refresh is blocked for account ${accountId}`, options);
    this.name = 'CloudAccountRefreshBlockedError';
  }
}

export const CLOUD_ACCOUNT_REAUTH_REQUIRED_REASON =
  'Repeated OAuth invalid_grant responses require account reauthorization';

export function isRetryableInvalidGrantRefreshError(
  error: unknown,
): error is OAuthTokenRefreshError {
  return error instanceof OAuthTokenRefreshError && error.code === 'invalid_grant';
}

export function createCloudAccountRefreshRequest(
  account: Pick<CloudAccount, 'id' | 'proxy_url' | 'token' | 'health'>,
  signal?: AbortSignal,
): CloudAccountRefreshRequest {
  return {
    accountId: account.id,
    refreshToken: account.token.refresh_token,
    proxyUrl: account.proxy_url,
    oauthClientKey: account.token.oauth_client_key,
    health: account.health,
    signal,
  };
}
