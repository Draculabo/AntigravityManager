import { CloudAccountRepo } from '@/modules/cloud-account/persistence/cloudHandler';
import type { CloudAccount } from '@/modules/cloud-account/types';
import { classifyAccountStatusFromError } from '@/modules/cloud-account/utils/account-status';
import { GoogleAPIService } from './GoogleAPIService';
import {
  CloudAccountRefreshService,
  createCloudAccountRefreshRequest,
  isRetryableInvalidGrantRefreshError,
} from './CloudAccountRefreshService';
import {
  clearAccountStatus,
  markAccountStatusFromError,
  mergeRefreshedToken,
} from './cloud-account-refresh-state.service';
import {
  CloudAccountHealthService,
  clearValidationHealthAfterSuccessfulProbe,
  evictAccountFromActiveLeaseCache,
  quarantineAccountInActiveLeaseCache,
} from './CloudAccountHealthService';
import { classifyForbiddenUpstreamError } from '@/modules/proxy-gateway/server/common/google-error-details';
import { proxyModelAvailabilityStore } from '@/modules/proxy-gateway/server/shared/services/model-availability.service';
import { AppError } from '@/shared/errors/appError';
import { logger } from '@/shared/logging/logger';

/** Desktop effects are owned by the caller; the core and post-import path omit them. */
export interface QuotaRefreshHooks {
  onPrimarySuccess?: (account: CloudAccount) => void;
  onRetrySuccess?: (account: CloudAccount) => void;
}

class QuotaRefreshTokenConflictError extends Error {
  constructor() {
    super('Account token changed during quota refresh');
  }
}

function recoverCachedQuotaOnRateLimit(
  account: CloudAccount,
  error: unknown,
): CloudAccount['quota'] | null {
  const classified = classifyAccountStatusFromError(error);
  if (!classified || classified.status !== 'rate_limited') {
    return null;
  }
  if (!account.quota || !account.quota.models || Object.keys(account.quota.models).length === 0) {
    return null;
  }
  return account.quota;
}

export async function refreshAccountQuotaCore(
  accountId: string,
  hooks: QuotaRefreshHooks = {},
): Promise<CloudAccount> {
  const account = await CloudAccountRepo.getAccount(accountId);
  if (!account) {
    throw new Error(`Account not found: ${accountId}`);
  }

  if (account.health?.service_disabled) {
    logger.warn(`Skipping quota refresh for ${account.email}: account is marked service_disabled`);
    return account;
  }

  let now = Math.floor(Date.now() / 1000);
  if (account.token.expiry_timestamp < now + 300) {
    logger.info(`Token for ${account.email} near expiry, refreshing...`);
    try {
      const refreshedToken = await CloudAccountRefreshService.refreshAccessToken(
        createCloudAccountRefreshRequest(account),
      );

      const expected = account.token;
      const updated = mergeRefreshedToken(expected, refreshedToken, now);
      if (!(await CloudAccountRepo.compareAndUpdateToken(account.id, expected, updated))) {
        throw new QuotaRefreshTokenConflictError();
      }
      account.token = updated;
    } catch (error) {
      if (error instanceof QuotaRefreshTokenConflictError) {
        throw error;
      }
      logger.warn(
        `Failed to refresh token during quota refresh precheck for ${account.email}`,
        error,
      );
      await markAccountStatusFromError(account, error);
      if (isRetryableInvalidGrantRefreshError(error)) {
        throw error;
      }
      throw new AppError('CLOUD_ACCOUNT_LOGIN_EXPIRED', 'Cloud account login expired', {
        messageKey: 'error.cloudAccountLoginExpired',
        reportToSentry: false,
        transportCode: 'UNAUTHORIZED',
        metadata: {
          accountId: account.id,
          email: account.email,
        },
        cause: error,
      });
    }
  }

  try {
    const previousAICredits = account.quota?.ai_credits;
    const quota = await GoogleAPIService.fetchQuota(account.token.access_token, account.proxy_url);

    try {
      const aiCredits = await GoogleAPIService.fetchAICredits(
        account.token.access_token,
        account.proxy_url,
      );
      if (aiCredits) {
        quota.ai_credits = aiCredits;
      } else {
        logger.info(`No AI credits returned for ${account.email} during quota refresh`);
        if (previousAICredits) {
          quota.ai_credits = previousAICredits;
        }
      }
    } catch (error) {
      logger.warn('Failed to fetch AI credits during quota refresh', error);
      if (previousAICredits) {
        quota.ai_credits = previousAICredits;
      }
    }

    account.quota = quota;
    await CloudAccountRepo.updateQuota(account.id, account.quota);
    await CloudAccountRepo.updateLastUsed(account.id);
    account.last_used = Math.floor(Date.now() / 1000);
    await clearAccountStatus(account);
    await clearValidationHealthAfterSuccessfulProbe(account);
    proxyModelAvailabilityStore.clearCapabilityFailures(account.id);
    hooks.onPrimarySuccess?.(account);
    return account;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : '';
    if (errorMessage === 'UNAUTHORIZED') {
      logger.warn(`Received 401 Unauthorized for ${account.email}; forcing token refresh`);
      try {
        const refreshedToken = await CloudAccountRefreshService.refreshAccessToken(
          createCloudAccountRefreshRequest(account),
        );
        now = Math.floor(Date.now() / 1000);

        const expected = account.token;
        const updated = mergeRefreshedToken(expected, refreshedToken, now);
        if (!(await CloudAccountRepo.compareAndUpdateToken(account.id, expected, updated))) {
          throw new QuotaRefreshTokenConflictError();
        }
        account.token = updated;

        const previousAICredits = account.quota?.ai_credits;
        const quota = await GoogleAPIService.fetchQuota(
          account.token.access_token,
          account.proxy_url,
        );

        try {
          const aiCredits = await GoogleAPIService.fetchAICredits(
            account.token.access_token,
            account.proxy_url,
          );
          if (aiCredits) {
            quota.ai_credits = aiCredits;
          } else {
            logger.info(`No AI credits returned for ${account.email} after token refresh`);
            if (previousAICredits) {
              quota.ai_credits = previousAICredits;
            }
          }
        } catch (error) {
          logger.warn('Failed to fetch AI credits after token refresh', error);
          if (previousAICredits) {
            quota.ai_credits = previousAICredits;
          }
        }

        account.quota = quota;
        await CloudAccountRepo.updateQuota(account.id, account.quota);
        await CloudAccountRepo.updateLastUsed(account.id);
        account.last_used = Math.floor(Date.now() / 1000);
        await clearAccountStatus(account);
        await clearValidationHealthAfterSuccessfulProbe(account);
        proxyModelAvailabilityStore.clearCapabilityFailures(account.id);
        hooks.onRetrySuccess?.(account);
        return account;
      } catch (refreshError) {
        if (refreshError instanceof QuotaRefreshTokenConflictError) {
          throw refreshError;
        }
        logger.error(
          `Failed to force refresh token or retry quota for ${account.email}`,
          refreshError,
        );
        const cachedQuota = recoverCachedQuotaOnRateLimit(account, refreshError);
        if (cachedQuota) {
          logger.warn(
            `[OAuth] Quota request is rate-limited for ${account.email}; reusing cached quota as fallback.`,
          );
          await markAccountStatusFromError(account, refreshError);
          return account;
        }
        await markAccountStatusFromError(account, refreshError);
        throw refreshError;
      }
    } else if (errorMessage === 'FORBIDDEN' || errorMessage.startsWith('FORBIDDEN')) {
      logger.warn(`Received 403 Forbidden for ${account.email}; marking account status from error`);
      const forbiddenClassification = classifyForbiddenUpstreamError({
        body: errorMessage,
        message: errorMessage,
      });
      if (forbiddenClassification.kind === 'service_disabled') {
        await quarantineAccountInActiveLeaseCache(account.id);
      }
      await markAccountStatusFromError(account, error);
      if (forbiddenClassification.kind === 'service_disabled') {
        const detectedAt = Date.now();
        account.health = await CloudAccountHealthService.mutateHealth(account.id, (health) => ({
          ...health,
          service_disabled: {
            status: 'disabled',
            reason: forbiddenClassification.reason ?? 'TOS_VIOLATION',
            detected_at_ms: detectedAt,
            appeal_url: forbiddenClassification.appealUrl,
            appeal_url_link_text: forbiddenClassification.appealLinkText,
            message: errorMessage.slice(0, 1000),
          },
        }));
        await evictAccountFromActiveLeaseCache(account.id);
      }
      return account;
    }

    const cachedQuota = recoverCachedQuotaOnRateLimit(account, error);
    if (cachedQuota) {
      logger.warn(
        `[OAuth] Quota request is rate-limited for ${account.email}; reusing cached quota as fallback.`,
      );
      await markAccountStatusFromError(account, error);
      return account;
    }

    await markAccountStatusFromError(account, error);
    logger.error(`Failed to refresh quota for ${account.email}`, error);
    throw error;
  }
}
