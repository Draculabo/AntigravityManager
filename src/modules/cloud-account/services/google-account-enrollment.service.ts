import { v4 as uuidv4 } from 'uuid';
import { CloudAccountRepo } from '@/modules/cloud-account/persistence/cloudHandler';
import { CloudAccountRefreshService } from '@/modules/cloud-account/services/CloudAccountRefreshService';
import { GoogleAPIService } from '@/modules/cloud-account/services/GoogleAPIService';
import type { CloudAccount } from '@/modules/cloud-account/types';
import { logger } from '@/shared/logging/logger';
import { prepareDesktopIdentityStorage } from '@/modules/identity-profile/public';
import { GoogleLoginOperation, GoogleLoginStepError } from './google-login-operation';

export class DuplicateGoogleAccountError extends GoogleLoginStepError {
  constructor() {
    super('duplicate-check', 'not-attempted', 'duplicate-account', undefined);
    this.message = 'Google account already exists';
    this.name = 'DuplicateGoogleAccountError';
  }
}

/** Exchange a Google authorization code and persist the resulting account in the owned profile. */
export async function enrollGoogleAccount(
  code: string,
  options: { oauthClientKey?: string; redirectUri: string; operation?: GoogleLoginOperation },
): Promise<CloudAccount> {
  const operation = options.operation ?? new GoogleLoginOperation();
  const tokenResp = await operation.run('token-exchange', () =>
    GoogleAPIService.exchangeCode(code, undefined, options.oauthClientKey, options.redirectUri),
  );
  const userInfo = await operation.run('user-info', () =>
    GoogleAPIService.getUserInfo(tokenResp.access_token),
  );
  if (
    await operation.run(
      'duplicate-check',
      () => CloudAccountRepo.getAccountByEmail(userInfo.email),
      'storage-failed',
    )
  ) {
    throw new DuplicateGoogleAccountError();
  }

  const now = Math.floor(Date.now() / 1000);
  const account: CloudAccount = {
    id: uuidv4(),
    provider: 'google',
    email: userInfo.email,
    name: userInfo.name || userInfo.email,
    avatar_url: userInfo.picture,
    token: {
      access_token: tokenResp.access_token,
      refresh_token: tokenResp.refresh_token || '',
      expires_in: tokenResp.expires_in,
      expiry_timestamp: now + tokenResp.expires_in,
      token_type: tokenResp.token_type,
      email: userInfo.email,
      oauth_client_key: tokenResp.oauth_client_key,
      is_gcp_tos: false,
      id_token: tokenResp.id_token,
    },
    created_at: now,
    last_used: now,
  };

  if (!account.token.refresh_token) {
    logger.warn('OAuth token exchange returned no refresh token; the account may expire soon');
  }
  await operation.run('identity-preparation', prepareDesktopIdentityStorage, 'storage-failed');
  operation.accountCommit = 'uncertain';
  await operation.run(
    'account-persist',
    () => CloudAccountRepo.addAccount(account),
    'storage-failed',
  );
  operation.accountCommit = 'confirmed';
  await operation.run(
    'account-finalize',
    () => CloudAccountRefreshService.clearFailureState(account.id),
    'storage-failed',
  );

  try {
    const quota = await GoogleAPIService.fetchQuota(account.token.access_token);
    try {
      const aiCredits = await GoogleAPIService.fetchAICredits(
        account.token.access_token,
        undefined,
      );
      if (aiCredits) {
        quota.ai_credits = aiCredits;
      }
    } catch {
      logger.warn('Failed to fetch initial AI credits');
    }
    account.quota = quota;
    await CloudAccountRepo.updateQuota(account.id, quota);
  } catch {
    logger.warn('Failed to fetch initial quota');
  }

  return account;
}
