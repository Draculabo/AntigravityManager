import { mergeQuotaWindows } from '../utils/quota-windows';
import {
  CloudAccountRepo,
  type CloudAccountWriteGuard,
} from '@/modules/cloud-account/persistence/cloudHandler';
import { assertAccountOAuthRecoveryReady } from '@/modules/cloud-account/persistence/oauth-recovery-service';
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
import { classifyForbiddenUpstreamError } from '@/server/gateway/common/google-error-details';
import { proxyModelAvailabilityStore } from '@/server/gateway/shared/services/model-availability.service';
import { AppError } from '@/shared/errors/appError';
import { logger } from '@/shared/logging/logger';
import { CloudAccountRefreshWriteback } from './cloud-account-refresh-writeback';
import {
  captureRefreshContext,
  CloudAccountRefreshContextChangedError,
} from './cloud-account-refresh-context';
import { CloudAccountQuotaObservation } from './cloud-account-quota-observation';

/** Desktop effects are owned by the caller; the core and post-import path omit them. */
export interface QuotaRefreshHooks {
  onPrimarySuccess?: (account: CloudAccount) => void;
  onRetrySuccess?: (account: CloudAccount) => void;
}

const activeQuotaRefreshes = new Map<string, Promise<CloudAccount>>();

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

/** Fail closed in the lease cache while recording a provider's confirmed service quarantine. */
export async function persistServiceDisabledFromQuotaFailure(
  account: CloudAccount,
  error: unknown,
  guard: CloudAccountWriteGuard,
  persistStatus: () => Promise<void>,
): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  const classification = classifyForbiddenUpstreamError({ body: message, message });
  if (classification.kind !== 'service_disabled') {
    await persistStatus();
    return;
  }

  guard(await CloudAccountRepo.getAccount(account.id));
  await quarantineAccountInActiveLeaseCache(account.id);
  await persistStatus();
  account.health = await CloudAccountHealthService.mutateHealth(
    account.id,
    (health) => ({
      ...health,
      service_disabled: {
        status: 'disabled',
        reason: classification.reason ?? 'TOS_VIOLATION',
        detected_at_ms: Date.now(),
        appeal_url: classification.appealUrl,
        appeal_url_link_text: classification.appealLinkText,
        message: message.slice(0, 1000),
      },
    }),
    { assertAccount: guard },
  );
  await evictAccountFromActiveLeaseCache(account.id, captureRefreshContext(account).leaseContext);
}

export async function refreshAccountQuotaCore(
  accountId: string,
  hooks: QuotaRefreshHooks = {},
): Promise<CloudAccount> {
  const active = activeQuotaRefreshes.get(accountId);
  if (active) {
    return active;
  }

  const operation = refreshAccountQuotaCoreOwned(accountId, hooks);
  activeQuotaRefreshes.set(accountId, operation);
  try {
    return await operation;
  } finally {
    if (activeQuotaRefreshes.get(accountId) === operation) {
      activeQuotaRefreshes.delete(accountId);
    }
  }
}

async function refreshAccountQuotaCoreOwned(
  accountId: string,
  hooks: QuotaRefreshHooks,
): Promise<CloudAccount> {
  const observation = new CloudAccountQuotaObservation(accountId);
  try {
    assertAccountOAuthRecoveryReady(accountId);
    const account = await CloudAccountRepo.getAccount(accountId);
    if (!account) {
      throw new Error(`Account not found: ${accountId}`);
    }
    if (account.health?.service_disabled) {
      logger.warn(
        `Skipping quota refresh for ${account.email}: account is marked service_disabled`,
      );
      return account;
    }
    const writeback = new CloudAccountRefreshWriteback(account, observation);

    let now = Math.floor(Date.now() / 1000);
    if (account.token.expiry_timestamp < now + 300) {
      logger.info(`Token for ${account.email} near expiry, refreshing...`);
      try {
        const refreshedToken = await CloudAccountRefreshService.refreshAccessToken(
          createCloudAccountRefreshRequest(account),
        );

        await writeback.updateToken(mergeRefreshedToken(account.token, refreshedToken, now));
      } catch (error) {
        if (error instanceof CloudAccountRefreshContextChangedError) {
          throw error;
        }
        logger.warn(
          `Failed to refresh token during quota refresh precheck for ${account.email}`,
          error,
        );
        await writeback.assertCurrent(error);
        observation.accept(error);
        await markAccountStatusFromError(account, error, writeback.guardFor(error));
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
      const quota = await GoogleAPIService.fetchQuota(
        account.token.access_token,
        account.proxy_url,
      );
      await writeback.assertCurrent();
      observation.accept();

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

      account.quota = mergeQuotaWindows(account.quota, quota);
      await CloudAccountRepo.updateQuota(account.id, account.quota, writeback.guard);
      CloudAccountRepo.updateLastUsed(account.id, writeback.guard);
      account.last_used = Math.floor(Date.now() / 1000);
      await clearAccountStatus(account, writeback.guard);
      await clearValidationHealthAfterSuccessfulProbe(account, writeback.guard);
      await writeback.assertCurrent();
      proxyModelAvailabilityStore.clearCapabilityFailures(account.id, Object.keys(quota.models));

      hooks.onPrimarySuccess?.(account);
      return account;
    } catch (error) {
      if (error instanceof CloudAccountRefreshContextChangedError) {
        throw error;
      }
      await writeback.assertCurrent(error);
      const errorMessage = error instanceof Error ? error.message : '';
      if (errorMessage === 'UNAUTHORIZED') {
        logger.warn(`Received 401 Unauthorized for ${account.email}; forcing token refresh`);
        try {
          const refreshedToken = await CloudAccountRefreshService.refreshAccessToken(
            createCloudAccountRefreshRequest(account),
          );
          now = Math.floor(Date.now() / 1000);

          await writeback.updateToken(mergeRefreshedToken(account.token, refreshedToken, now));

          const previousAICredits = account.quota?.ai_credits;
          const quota = await GoogleAPIService.fetchQuota(
            account.token.access_token,
            account.proxy_url,
          );
          await writeback.assertCurrent();
          observation.accept();

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

          account.quota = mergeQuotaWindows(account.quota, quota);
          await CloudAccountRepo.updateQuota(account.id, account.quota, writeback.guard);
          CloudAccountRepo.updateLastUsed(account.id, writeback.guard);
          account.last_used = Math.floor(Date.now() / 1000);
          await clearAccountStatus(account, writeback.guard);
          await clearValidationHealthAfterSuccessfulProbe(account, writeback.guard);
          await writeback.assertCurrent();
          proxyModelAvailabilityStore.clearCapabilityFailures(
            account.id,
            Object.keys(quota.models),
          );

          hooks.onRetrySuccess?.(account);
          return account;
        } catch (refreshError) {
          if (refreshError instanceof CloudAccountRefreshContextChangedError) {
            throw refreshError;
          }
          await writeback.assertCurrent(refreshError);
          observation.accept(refreshError);
          logger.error(
            `Failed to force refresh token or retry quota for ${account.email}`,
            refreshError,
          );
          const cachedQuota = recoverCachedQuotaOnRateLimit(account, refreshError);
          if (cachedQuota) {
            logger.warn(
              `[OAuth] Quota request is rate-limited for ${account.email}; reusing cached quota as fallback.`,
            );
            await writeback.assertCurrent(refreshError);
            await markAccountStatusFromError(
              account,
              refreshError,
              writeback.guardFor(refreshError),
            );
            return account;
          }
          await markAccountStatusFromError(account, refreshError, writeback.guardFor(refreshError));
          throw refreshError;
        }
      } else if (errorMessage.startsWith('FORBIDDEN')) {
        logger.warn(
          `Received 403 Forbidden for ${account.email}; marking account status from error`,
        );
        await writeback.assertCurrent(error);
        observation.accept(error);
        const guard = writeback.guardFor(error);
        await persistServiceDisabledFromQuotaFailure(account, error, guard, () =>
          markAccountStatusFromError(account, error, guard),
        );
        return account;
      }

      observation.accept(error);
      const cachedQuota = recoverCachedQuotaOnRateLimit(account, error);
      if (cachedQuota) {
        logger.warn(
          `[OAuth] Quota request is rate-limited for ${account.email}; reusing cached quota as fallback.`,
        );
        await writeback.assertCurrent(error);
        await markAccountStatusFromError(account, error, writeback.guardFor(error));
        return account;
      }

      await writeback.assertCurrent(error);
      await markAccountStatusFromError(account, error, writeback.guardFor(error));
      logger.error(`Failed to refresh quota for ${account.email}`, error);
      throw error;
    }
  } finally {
    observation.close();
  }
}
