import { v4 as uuidv4 } from 'uuid';
import { CloudAccountRepo } from '@/modules/cloud-account/persistence/cloudHandler';
import { CloudAccountRefreshService } from '@/modules/cloud-account/services/CloudAccountRefreshService';
import { GoogleAPIService } from '@/modules/cloud-account/services/GoogleAPIService';
import type { CloudAccount } from '@/modules/cloud-account/types';
import { logger } from '@/shared/logging/logger';
import { prepareDesktopIdentityStorage } from '@/modules/identity-profile/public';

export class DuplicateGoogleAccountError extends Error {
  constructor() {
    super('Google account already exists');
    this.name = 'DuplicateGoogleAccountError';
  }
}

/** Exchange a Google authorization code and persist the resulting encrypted account. */
export async function enrollGoogleAccount(
  code: string,
  options: { oauthClientKey?: string; redirectUri: string },
): Promise<CloudAccount> {
  const tokenResp = await GoogleAPIService.exchangeCode(
    code,
    undefined,
    options.oauthClientKey,
    options.redirectUri,
  );
  const userInfo = await GoogleAPIService.getUserInfo(tokenResp.access_token);
  if (await CloudAccountRepo.getAccountByEmail(userInfo.email)) {
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
  await prepareDesktopIdentityStorage();
  await CloudAccountRepo.addAccount(account);
  await CloudAccountRefreshService.clearFailureState(account.id);

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
