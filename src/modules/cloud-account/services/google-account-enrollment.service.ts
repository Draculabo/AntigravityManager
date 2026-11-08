import { mergeQuotaWindows } from '../utils/quota-windows';
import { v4 as uuidv4 } from 'uuid';
import { isEqual } from 'lodash-es';
import {
  CloudAccountRepo,
  CloudAccountEmailConflictError,
  type CloudAccountWriteGuard,
} from '@/modules/cloud-account/persistence/cloudHandler';
import { CloudAccountRefreshService } from '@/modules/cloud-account/services/CloudAccountRefreshService';
import { GoogleAPIService } from '@/modules/cloud-account/services/GoogleAPIService';
import type { CloudAccount } from '@/modules/cloud-account/types';
import { logger } from '@/shared/logging/logger';
import { prepareDesktopIdentityStorage } from '@/modules/identity-profile/public';
import { GoogleLoginOperation, GoogleLoginStepError } from './google-login-operation';
import { captureTokenWriteGuard } from './cloud-account-refresh-writeback';
import { CloudAccountRefreshContextChangedError } from './cloud-account-refresh-context';
import { CloudAccountQuotaObservation } from './cloud-account-quota-observation';

export class DuplicateGoogleAccountError extends GoogleLoginStepError {
  constructor(
    stage: 'duplicate-check' | 'account-persist' = 'duplicate-check',
    cause?: CloudAccountEmailConflictError,
  ) {
    super(stage, 'not-attempted', 'duplicate-account', cause);
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
  const storedAccount = await operation.run(
    'account-persist',
    async () => {
      try {
        return await CloudAccountRepo.insertAccount(account, userInfo.id);
      } catch (error) {
        if (error instanceof CloudAccountEmailConflictError) {
          operation.accountCommit = 'not-attempted';
          throw new DuplicateGoogleAccountError('account-persist', error);
        }
        throw error;
      }
    },
    'storage-failed',
  );
  operation.accountCommit = 'confirmed';
  const observation = new CloudAccountQuotaObservation(storedAccount.id);
  try {
    const tokenGuard = captureTokenWriteGuard(storedAccount);
    const guard: CloudAccountWriteGuard = (current) => {
      observation.assertCurrent();
      tokenGuard(current);
    };
    const initialHealth = structuredClone(storedAccount.health);
    const assertCurrent = () => CloudAccountRepo.assertCurrentAccount(storedAccount.id, guard);
    await operation.run(
      'account-finalize',
      async () => {
        await CloudAccountRefreshService.clearFailureState(storedAccount.id, (current) => {
          guard(current);
          if (!isEqual(current?.health, initialHealth)) {
            throw new CloudAccountRefreshContextChangedError(storedAccount.id);
          }
        });
        assertCurrent();
        try {
          const quota = await GoogleAPIService.fetchQuota(storedAccount.token.access_token);
          assertCurrent();
          observation.accept();
          try {
            const aiCredits = await GoogleAPIService.fetchAICredits(
              storedAccount.token.access_token,
              undefined,
            );
            assertCurrent();
            if (aiCredits) {
              quota.ai_credits = aiCredits;
            }
          } catch (error) {
            if (error instanceof CloudAccountRefreshContextChangedError) {
              throw error;
            }
            assertCurrent();
            logger.warn('Failed to fetch initial AI credits');
          }
          const reconciled = mergeQuotaWindows(storedAccount.quota, quota);
          await CloudAccountRepo.updateQuota(storedAccount.id, reconciled, guard);
          assertCurrent();
          storedAccount.quota = reconciled;
        } catch (error) {
          if (error instanceof CloudAccountRefreshContextChangedError) {
            throw error;
          }
          assertCurrent();
          observation.accept(error);
          logger.warn('Failed to fetch initial quota');
        }
      },
      'storage-failed',
    );
    return storedAccount;
  } finally {
    observation.close();
  }
}
