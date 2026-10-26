import { CloudAccountRepo, type CloudAccountWriteGuard } from '../persistence/cloudHandler';
import type { CloudAccount } from '../types';
import { GoogleAPIService, type TokenResponse } from './GoogleAPIService';
import {
  CLOUD_ACCOUNT_REAUTH_REQUIRED_REASON,
  CloudAccountRefreshBlockedError,
  isRetryableInvalidGrantRefreshError,
} from './CloudAccountRefreshService';
import { classifyAccountStatusFromError } from '../utils/account-status';

export function hasReusableCachedQuota(account: CloudAccount): boolean {
  return !!account.quota?.models && Object.keys(account.quota.models).length > 0;
}

export function isUnauthorizedError(error: unknown): boolean {
  return error instanceof Error && error.message === 'UNAUTHORIZED';
}

export async function persistMonitorAccountStatusFromError(
  accountId: string,
  error: unknown,
  guard: CloudAccountWriteGuard,
): Promise<void> {
  if (isRetryableInvalidGrantRefreshError(error)) {
    return;
  }
  if (error instanceof CloudAccountRefreshBlockedError) {
    await CloudAccountRepo.setAccountStatus(
      accountId,
      'expired',
      CLOUD_ACCOUNT_REAUTH_REQUIRED_REASON,
      guard,
    );
    return;
  }

  const classified = classifyAccountStatusFromError(error);
  if (classified) {
    await CloudAccountRepo.setAccountStatus(accountId, classified.status, classified.reason, guard);
  }
}

export function mergeRefreshedToken(
  currentToken: CloudAccount['token'],
  newToken: TokenResponse,
  now: number,
): CloudAccount['token'] {
  return {
    ...currentToken,
    access_token: newToken.access_token,
    refresh_token: newToken.refresh_token ?? currentToken.refresh_token,
    expires_in: newToken.expires_in,
    expiry_timestamp: now + newToken.expires_in,
    id_token: newToken.id_token ?? currentToken.id_token,
    oauth_client_key: GoogleAPIService.normalizeRefreshedOAuthClientKey(
      currentToken,
      newToken.oauth_client_key,
    ),
  };
}
