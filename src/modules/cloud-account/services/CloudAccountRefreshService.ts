import type { CloudAccount } from '@/modules/cloud-account/types';
import type { CloudAccountWriteGuard } from '../persistence/cloudHandler';
import {
  CloudAccountHealthService,
  evictAccountFromActiveLeaseCache,
  syncAccountOAuthHealthToActiveLeaseCache,
} from './CloudAccountHealthService';
import { GoogleAPIService, OAuthTokenRefreshError, type TokenResponse } from './GoogleAPIService';
import { logger } from '@/shared/logging/logger';
import { assertAccountOAuthRecoveryReady } from '@/modules/cloud-account/persistence/oauth-recovery-service';
import {
  captureRefreshContext,
  CloudAccountRefreshContextChangedError,
} from './cloud-account-refresh-context';

export interface CloudAccountRefreshRequest {
  accountId: string;
  refreshToken: string;
  proxyUrl?: string;
  oauthClientKey?: string;
  health?: CloudAccount['health'];
  signal?: AbortSignal;
  /** Same-process owner fence, also applied inside health mutations. */
  assertCurrent?: () => void;
}

function withoutOAuthFailure(health: CloudAccount['health']): CloudAccount['health'] {
  return health
    ? { validation: health.validation, service_disabled: health.service_disabled }
    : undefined;
}

/**
 * Owns account-level refresh revocation state. The provider client performs the
 * short same-request retry; this service requires two failed refresh operations
 * before durably removing an account from automatic selection.
 */
export class CloudAccountRefreshService {
  private static readonly operationLocks = new Map<string, Promise<void>>();

  static async refreshAccessToken(request: CloudAccountRefreshRequest): Promise<TokenResponse> {
    const snapshot = { ...request };
    return this.runAccountOperation(snapshot.accountId, () =>
      this.refreshAccessTokenLocked(snapshot),
    );
  }

  static async clearFailureState(accountId: string, guard?: CloudAccountWriteGuard): Promise<void> {
    await this.runAccountOperation(accountId, async () => {
      if (guard) {
        guard(await CloudAccountHealthService.getAccount(accountId));
      }
      const health = await CloudAccountHealthService.getHealth(accountId);
      if (health?.oauth) {
        await CloudAccountHealthService.mutateHealth(
          accountId,
          withoutOAuthFailure,
          guard ? { assertAccount: guard } : undefined,
        );
      }

      const { reloadNestServerAccountLeaseCache } = await import('@/server/main');
      if (guard) {
        guard(await CloudAccountHealthService.getAccount(accountId));
      }
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
    assertAccountOAuthRecoveryReady(request.accountId);
    const assertOwner = () => {
      request.signal?.throwIfAborted();
      request.assertCurrent?.();
    };
    assertOwner();
    // request.health is only a transport hint. The persisted value is authoritative
    // because another caller may have changed the account while this request waited.
    const account = await CloudAccountHealthService.getAccount(request.accountId);
    assertOwner();
    if (
      !account ||
      account.token.refresh_token !== request.refreshToken ||
      (account.token.oauth_client_key?.trim() || undefined) !==
        (request.oauthClientKey?.trim() || undefined)
    ) {
      throw new CloudAccountRefreshContextChangedError(request.accountId);
    }
    const context = captureRefreshContext(account);
    const assertContext = (current: CloudAccount | undefined, cause?: unknown) => {
      assertOwner();
      context.assertCurrent(current, cause);
    };
    const effectiveHealth = account.health;
    if (effectiveHealth?.oauth?.refresh_blocked) {
      throw new CloudAccountRefreshBlockedError(request.accountId);
    }
    const expectedToken = { ...account.token };

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
      assertOwner();
      if (effectiveHealth?.oauth) {
        try {
          const clearedHealth = await CloudAccountHealthService.mutateHealth(
            request.accountId,
            withoutOAuthFailure,
            { expectedToken, assertAccount: (current) => assertContext(current) },
          );
          assertOwner();
          await syncAccountOAuthHealthToActiveLeaseCache(
            request.accountId,
            clearedHealth?.oauth,
            context.leaseContext,
          );
        } catch {
          // Do not discard credentials already rotated by the provider on a health update failure.
          logger.warn('Unable to clear OAuth failure state after successful refresh');
        }
      }
      assertContext(await CloudAccountHealthService.getAccount(request.accountId));
      return refreshedToken;
    } catch (error) {
      try {
        assertOwner();
      } catch (ownerError) {
        if (ownerError !== error) {
          throw new AggregateError([error, ownerError], 'OAuth refresh completion lost its owner');
        }
        throw ownerError;
      }
      if (!(error instanceof OAuthTokenRefreshError) || error.code !== 'invalid_grant') {
        throw error;
      }

      const failureAt = Date.now();
      let updatedHealth: CloudAccount['health'];
      try {
        updatedHealth = await CloudAccountHealthService.mutateHealth(
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
          { expectedToken, assertAccount: (current) => assertContext(current, error) },
        );
      } catch (healthError) {
        if (
          healthError instanceof Error &&
          healthError.message === 'Account credentials changed during health update'
        ) {
          throw error;
        }
        throw healthError;
      }
      if (!updatedHealth?.oauth?.refresh_blocked) {
        assertOwner();
        await syncAccountOAuthHealthToActiveLeaseCache(
          request.accountId,
          updatedHealth?.oauth,
          context.leaseContext,
        );
        assertContext(await CloudAccountHealthService.getAccount(request.accountId), error);
        throw error;
      }

      assertOwner();
      await evictAccountFromActiveLeaseCache(request.accountId, context.leaseContext);
      // Our own quarantine can cancel its request owner; preserve the confirmed revocation cause.
      context.assertCurrent(await CloudAccountHealthService.getAccount(request.accountId), error);
      throw new CloudAccountRefreshBlockedError(request.accountId, { cause: error });
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
