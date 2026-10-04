import { CloudAccountRepo } from '@/modules/cloud-account/persistence/cloudHandler';
import type { CloudAccount } from '@/modules/cloud-account/types';
import { classifyAccountStatusFromError } from '@/modules/cloud-account/utils/account-status';
import { GoogleAPIService, type TokenResponse } from './GoogleAPIService';
import {
  CLOUD_ACCOUNT_REAUTH_REQUIRED_REASON,
  CloudAccountRefreshBlockedError,
  isRetryableInvalidGrantRefreshError,
} from './CloudAccountRefreshService';

export function mergeRefreshedToken(
  currentToken: CloudAccount['token'],
  refreshedToken: TokenResponse,
  now: number,
): CloudAccount['token'] {
  return {
    ...currentToken,
    access_token: refreshedToken.access_token,
    refresh_token: refreshedToken.refresh_token ?? currentToken.refresh_token,
    expires_in: refreshedToken.expires_in,
    expiry_timestamp: now + refreshedToken.expires_in,
    token_type: refreshedToken.token_type,
    id_token: refreshedToken.id_token ?? currentToken.id_token,
    oauth_client_key: GoogleAPIService.normalizeRefreshedOAuthClientKey(
      currentToken,
      refreshedToken.oauth_client_key,
    ),
  };
}

export async function markAccountStatusFromError(
  account: CloudAccount,
  error: unknown,
): Promise<void> {
  if (isRetryableInvalidGrantRefreshError(error)) {
    return;
  }
  if (error instanceof CloudAccountRefreshBlockedError) {
    account.status = 'expired';
    account.status_reason = CLOUD_ACCOUNT_REAUTH_REQUIRED_REASON;
    await CloudAccountRepo.setAccountStatus(
      account.id,
      'expired',
      CLOUD_ACCOUNT_REAUTH_REQUIRED_REASON,
    );
    return;
  }

  const classified = classifyAccountStatusFromError(error);
  if (!classified) {
    return;
  }

  account.status = classified.status;
  account.status_reason = classified.reason;
  await CloudAccountRepo.setAccountStatus(account.id, classified.status, classified.reason);
}

export async function clearAccountStatus(account: CloudAccount): Promise<void> {
  account.status = 'active';
  account.status_reason = undefined;
  await CloudAccountRepo.setAccountStatus(account.id, 'active', null);
}
