import { prepareLaunchContext, prepareClientAccountWrite } from '@/modules/antigravity-runtime';
import { accountOwnerEvents } from './account-owner-events.service';
import { isEmpty, isString } from 'lodash-es';
import { CloudAccountRepo } from '@/modules/cloud-account/persistence/cloudHandler';
import { CloudAccountDeviceBindingStore } from '@/modules/cloud-account/persistence/cloud-account-device-binding-store';
import { CloudAccountSettingsStore } from '@/modules/cloud-account/persistence/cloud-account-settings-store';
import { GoogleAPIService } from '@/modules/cloud-account/services/GoogleAPIService';
import type { CloudAccount } from '@/modules/cloud-account/types';
import { logger } from '@/shared/logging/logger';
import {
  ensureGlobalOriginalFromCurrentStorage,
  generateDeviceProfile,
  isIdentityProfileApplyEnabled,
  saveGlobalOriginalProfile,
} from '@/modules/identity-profile/ipc/handler';
import { runWithSwitchGuard } from '@/modules/antigravity-runtime/switch/switchGuard';
import { executeSwitchFlow } from '@/modules/antigravity-runtime/switch/switchFlow';
import type { SwitchFailureReason } from '@/modules/antigravity-runtime/switch/switchMetrics';
import { ENTERPRISE_OAUTH_CLIENT_KEY } from './cloud-account-oauth-settings.service';
import type { AntigravityAppTarget } from '@/shared/platform/antigravityAppTarget';
import { extractErrorMessage } from '@/modules/cloud-account/utils/account-status';
import { withTimingTrace } from '@/shared/observability/timingTrace';
import {
  CloudAccountRefreshBlockedError,
  CloudAccountRefreshService,
  createCloudAccountRefreshRequest,
  isRetryableInvalidGrantRefreshError,
} from './CloudAccountRefreshService';
import {
  clearAccountStatus,
  markAccountStatusFromError,
  mergeRefreshedToken,
} from './cloud-account-refresh-state.service';
import { CloudAccountSwitchError } from './cloud-account-switch.error';
import type { CloudAccountSwitchErrorCode } from './cloud-account-switch.schema';

export interface CloudAccountSwitchOptions {
  presentationReason?: 'manual' | 'auto';
  onSuccess?(account: CloudAccount): Promise<void> | void;
}

function publicFailureCode(reason: SwitchFailureReason): CloudAccountSwitchErrorCode {
  switch (reason) {
    case 'missing_bound_profile':
    case 'apply_device_profile_failed':
      return 'identity-profile-required';
    case 'process_close_failed':
    case 'start_process_failed':
      return 'process-control-failed';
    case 'perform_switch_failed':
      return 'target-write-failed';
    default:
      return 'switch-failed';
  }
}

function isEnterpriseClient(clientKey?: string): boolean {
  if (!clientKey) {
    return false;
  }
  return clientKey.trim().toLowerCase() === ENTERPRISE_OAUTH_CLIENT_KEY;
}

function normalizeProjectId(projectId?: string): string | null {
  if (!isString(projectId)) {
    return null;
  }
  const normalized = projectId.trim();
  return normalized === '' ? null : normalized;
}

export function formatSwitchRefreshError(error: unknown): string {
  if (isRetryableInvalidGrantRefreshError(error)) {
    return 'Token refresh was rejected after confirmation. Retry later before reauthorizing the account.';
  }
  if (error instanceof CloudAccountRefreshBlockedError) {
    return 'Token refresh failed repeatedly. Please re-login and complete authorization.';
  }

  const reason = extractErrorMessage(error);
  const normalized = reason.toLowerCase();
  if (
    normalized.includes('unauthorized_client') ||
    normalized.includes('invalid_client') ||
    normalized.includes('invalid_grant')
  ) {
    return `Token refresh failed: OAuth client is not authorized for this account. Please re-login and complete authorization. Raw error: ${reason}`;
  }
  if (
    normalized.includes('verify your account') ||
    normalized.includes('further action is required') ||
    normalized.includes('validation required') ||
    normalized.includes('validation_url') ||
    normalized.includes('appeal_url')
  ) {
    return `Token refresh failed: account requires additional verification. Please finish verification and retry. Raw error: ${reason}`;
  }
  if (
    normalized.includes('resource_exhausted') ||
    normalized.includes('resource has been exhausted')
  ) {
    return `Token refresh failed: account is rate-limited or temporarily restricted (RESOURCE_EXHAUSTED). Please retry later. Raw error: ${reason}`;
  }
  return `Token refresh failed: ${reason}`;
}

async function ensureEnterpriseProjectReady(account: CloudAccount): Promise<void> {
  if (!isEnterpriseClient(account.token.oauth_client_key)) {
    return;
  }

  if (normalizeProjectId(account.token.project_id)) {
    return;
  }

  logger.warn(
    `[OAuth] Account ${account.email} is using enterprise OAuth client but missing project_id. Resolving before switch...`,
  );

  try {
    const resolvedProjectId = await GoogleAPIService.fetchProjectId(
      account.token.access_token,
      account.proxy_url,
    );
    const normalizedProjectId = normalizeProjectId(resolvedProjectId ?? undefined);
    if (normalizedProjectId) {
      account.token.project_id = normalizedProjectId;
      await CloudAccountRepo.updateToken(account.id, account.token);
      logger.info(`[OAuth] Successfully resolved and saved project_id for ${account.email}`);
    } else {
      logger.warn(
        `[OAuth] Project ID is unavailable for ${account.email}; continuing switch without blocking.`,
      );
    }
  } catch (error) {
    logger.warn(
      `[OAuth] Failed to auto-resolve project ID for ${account.email} during switch: ${extractErrorMessage(
        error,
      )}. Continuing switch without blocking.`,
    );
  }
}

export async function switchCloudAccountCore(
  accountId: string,
  appTarget?: AntigravityAppTarget,
  options: CloudAccountSwitchOptions = {},
): Promise<void> {
  await runWithSwitchGuard(
    'cloud-account-switch',
    async () => {
      let failureCode: CloudAccountSwitchErrorCode = 'switch-failed';
      try {
        const account = await CloudAccountRepo.getAccount(accountId);
        if (!account) {
          throw new CloudAccountSwitchError('account-not-found');
        }

        logger.info(`Switching to cloud account: ${account.email} (${account.id})`);
        const launchContext =
          appTarget === 'agy'
            ? undefined
            : await prepareLaunchContext(appTarget === 'ide' ? 'ide' : 'classic');
        await withTimingTrace(
          'switch.cloud.prepare',
          {
            accountId: account.id,
            appTarget: appTarget || 'classic',
          },
          async (trace) => {
            trace.phaseSync('deviceProfileSetupMs', () => {
              if (appTarget !== 'agy') {
                ensureGlobalOriginalFromCurrentStorage(appTarget, launchContext?.pathOptions);
              }

              if (!account.device_profile) {
                const generated = generateDeviceProfile();
                CloudAccountDeviceBindingStore.setDeviceBinding(
                  account.id,
                  generated,
                  'auto_generated',
                );
                saveGlobalOriginalProfile(generated);
                account.device_profile = generated;
              }
            });

            const tokenRefreshPromise = (async () => {
              const now = Math.floor(Date.now() / 1000);
              if (
                !isString(account.token.refresh_token) ||
                isEmpty(account.token.refresh_token.trim())
              ) {
                logger.warn(
                  `Token for ${account.email} has no refresh token; switched IDE session may expire without recovery.`,
                );
                return;
              }

              logger.info(`Refreshing token for ${account.email} before IDE injection...`);
              try {
                const refreshedToken = await CloudAccountRefreshService.refreshAccessToken(
                  createCloudAccountRefreshRequest(account),
                );

                const updatedToken = mergeRefreshedToken(account.token, refreshedToken, now);
                await CloudAccountRepo.updateToken(account.id, updatedToken);

                account.token = updatedToken;
                logger.info(`Token refreshed for ${account.email}`);
              } catch (error) {
                logger.warn('Failed to refresh token before IDE injection', error);
                await markAccountStatusFromError(account, error);
                if (error instanceof CloudAccountRefreshBlockedError) {
                  throw new CloudAccountSwitchError('reauth-required');
                }
                throw new Error(formatSwitchRefreshError(error));
              }
            })();

            await trace.phase('tokenRefreshMs', async () => {
              await tokenRefreshPromise;
            });

            await trace.phase('enterpriseProjectReadyMs', async () => {
              await ensureEnterpriseProjectReady(account);
            });
          },
        );

        const preparedWrite = await prepareClientAccountWrite(
          { email: account.email, name: account.name || account.email, token: account.token },
          appTarget,
          launchContext?.pathOptions,
        );
        await executeSwitchFlow({
          scope: 'cloud',
          appTarget,
          targetProfile: account.device_profile || null,
          applyFingerprint: isIdentityProfileApplyEnabled(),
          useCredentialStore: preparedWrite.storage === 'credential-store',
          processExitTimeoutMs: 10000,
          launchContext,
          onFailure: (reason) => {
            failureCode = publicFailureCode(reason);
          },
          performSwitch: preparedWrite.write,
          afterSwitchSuccess: async () => {
            CloudAccountRepo.updateLastUsed(account.id);
            CloudAccountRepo.setActive(account.id);
            CloudAccountSettingsStore.setActiveForTarget(appTarget, account.id);
            await clearAccountStatus(account);

            logger.info(`Successfully switched to cloud account: ${account.email}`);
            accountOwnerEvents.publish({
              kind: 'account-switched',
              accountId: account.id,
              target: appTarget ?? 'classic',
              reason: options.presentationReason ?? 'manual',
            });
            try {
              await options.onSuccess?.(account);
            } catch {
              logger.warn('Account switch presentation effect failed');
            }
          },
        });
      } catch (error) {
        logger.error('Failed to switch cloud account', { kind: failureCode });
        throw error instanceof CloudAccountSwitchError
          ? error
          : new CloudAccountSwitchError(failureCode);
      }
    },
    appTarget,
  );
}
