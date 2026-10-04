import fs from 'fs';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { CloudAccountRepo } from '@/modules/cloud-account/persistence/cloudHandler';
import { CloudAccountSettingsStore } from '@/modules/cloud-account/persistence/cloud-account-settings-store';
import { GoogleAPIService, type QuotaData, type TokenResponse } from './GoogleAPIService';
import {
  CLOUD_ACCOUNT_REAUTH_REQUIRED_REASON,
  CloudAccountRefreshBlockedError,
  CloudAccountRefreshService,
  createCloudAccountRefreshRequest,
  isRetryableInvalidGrantRefreshError,
} from './CloudAccountRefreshService';
import { clearValidationHealthAfterSuccessfulProbe } from './CloudAccountHealthService';
import { AutoSwitchService } from './AutoSwitchService';
import { logger } from '@/shared/logging/logger';
import { classifyAccountStatusFromError } from '@/modules/cloud-account/utils/account-status';
import type { CloudAccount } from '@/modules/cloud-account/types';
import { AntigravityAppTargetSchema } from '@/shared/platform/antigravityAppTarget';
import type { AntigravityAppTarget } from '@/shared/platform/antigravityAppTarget';
import { getAntigravityStoragePaths } from '@/shared/platform/paths';
import { detectAgyCliExecutablePath } from '@/modules/antigravity-runtime/binary-patch/agyCliPathDetection';
import { ConfigManager } from '@/modules/config/ipc/manager';
import { proxyModelAvailabilityStore } from '@/modules/proxy-gateway/server/shared/services/model-availability.service';
import { WeeklyWarmupService } from './WeeklyWarmupService';
import type { WeeklyWarmupExecutor } from './weekly-warmup-contract';
import { cloudAccountWeeklyWarmupRunner } from './cloud-account-weekly-warmup-runner';

const AUTO_SWITCH_CANDIDATE_TARGETS: AntigravityAppTarget[] = [
  ...AntigravityAppTargetSchema.options,
];

/**
 * Whether the agy CLI is installed, so its credential-store switch can actually run. Unlike the
 * desktop targets, agy has no storage.json; its switch reads the keychain and the CLI binary.
 */
function isAgyCliInstalled(): boolean {
  try {
    const config = ConfigManager.getCachedConfig() ?? ConfigManager.loadConfig();
    return (
      detectAgyCliExecutablePath({ configuredPath: config.antigravity_cli_executable }) !== null
    );
  } catch (error) {
    logger.warn('AutoSwitch: Failed to detect the agy CLI; excluding it from auto-switch', error);
    return false;
  }
}

function hasAutoSwitchStorage(target: AntigravityAppTarget): boolean {
  return getAntigravityStoragePaths(target).some((storagePath) => fs.existsSync(storagePath));
}

/**
 * A target only participates in auto-switch when its switch can actually run: the desktop targets
 * need a storage.json on disk, and agy needs its CLI binary. Resolving this per poll keeps an
 * absent install from failing the switch (desktop targets throw storage_json_not_found).
 */
function resolveAutoSwitchTargets(): AntigravityAppTarget[] {
  return AUTO_SWITCH_CANDIDATE_TARGETS.filter((target) =>
    target === 'agy' ? isAgyCliInstalled() : hasAutoSwitchStorage(target),
  );
}
const BooleanSettingSchema = z.boolean();

async function persistMonitorAccountStatusFromError(
  accountId: string,
  error: unknown,
): Promise<void> {
  if (isRetryableInvalidGrantRefreshError(error)) {
    return;
  }
  if (error instanceof CloudAccountRefreshBlockedError) {
    await CloudAccountRepo.setAccountStatus(
      accountId,
      'expired',
      CLOUD_ACCOUNT_REAUTH_REQUIRED_REASON,
    );
    return;
  }

  const classified = classifyAccountStatusFromError(error);
  if (classified) {
    await CloudAccountRepo.setAccountStatus(accountId, classified.status, classified.reason);
  }
}

function hasReusableCachedQuota(account: {
  quota?: { models?: Record<string, unknown> };
}): boolean {
  if (!account.quota || !account.quota.models) {
    return false;
  }
  return Object.keys(account.quota.models).length > 0;
}

function isUnauthorizedError(error: unknown): boolean {
  return error instanceof Error && error.message === 'UNAUTHORIZED';
}

function mergeRefreshedToken(
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

export class CloudMonitorService {
  private static acceptingPolls = true;
  private static effects: { onQuotaUpdated(accounts: CloudAccount[]): void } = {
    onQuotaUpdated: () => {},
  };

  static configureEffects(effects: { onQuotaUpdated(accounts: CloudAccount[]): void }): void {
    this.effects = effects;
  }

  static openAdmission(): void {
    this.acceptingPolls = true;
  }
  static closeAdmission(): void {
    this.acceptingPolls = false;
    this.stop();
  }
  static async drain(): Promise<void> {
    await this.activePollPromise;
    await cloudAccountWeeklyWarmupRunner.drain();
  }
  private static intervalId: NodeJS.Timeout | null = null;
  private static POLL_INTERVAL = 1000 * 60 * 5; // 5 minutes
  private static DEBOUNCE_TIME = 10000; // 10 seconds
  private static lastFocusTime: number = 0;
  private static activePollPromise: Promise<void> | null = null;
  private static stopped = false;
  private static stopEpoch = 0;

  private static isAutoSwitchEnabled(): boolean {
    return CloudAccountSettingsStore.getSetting('auto_switch_enabled', false, BooleanSettingSchema);
  }

  static configureWeeklyWarmupExecutor(executor: WeeklyWarmupExecutor): void {
    cloudAccountWeeklyWarmupRunner.configure(executor);
  }

  static isContinuousPollingEnabled(): boolean {
    return this.isAutoSwitchEnabled() || WeeklyWarmupService.isEnabled();
  }

  static syncSchedule(): void {
    if (this.isContinuousPollingEnabled()) {
      this.start();
      return;
    }
    this.stop();
  }

  // Helper for testing
  static resetStateForTesting() {
    this.acceptingPolls = true;
    WeeklyWarmupService.resetStateForTesting();
    this.lastFocusTime = 0;
    this.activePollPromise = null;
    cloudAccountWeeklyWarmupRunner.resetStateForTesting();
    this.stop();
  }

  static start() {
    if (!this.acceptingPolls) {
      return;
    }
    if (this.intervalId) return;
    logger.info('Starting CloudMonitorService...');
    cloudAccountWeeklyWarmupRunner.start();

    // Set lastFocusTime to now to prevent "double-dip" on startup (focus event immediately after start)
    this.lastFocusTime = Date.now();

    // Initial Poll
    this.poll().catch((e) => logger.error('Initial poll failed', e));

    this.startInterval();
  }

  static stop() {
    this.stopped = true;
    this.stopEpoch++;
    cloudAccountWeeklyWarmupRunner.cancel();
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      logger.info('Stopped CloudMonitorService');
    }
  }

  static async drainWeeklyWarmups(): Promise<void> {
    await cloudAccountWeeklyWarmupRunner.drain();
  }

  /**
   * Called when the application window gains focus.
   * Triggers an immediate poll if not rate-limited by debounce.
   */
  static async handleAppFocus() {
    const now = Date.now();

    // 1. Concurrency Guard: If we are already polling, don't pile up requests
    if (this.activePollPromise) {
      logger.info('Monitor: App focused, but polling is already in progress. Skipping.');
      return;
    }

    // 2. Debounce: If we focused recently, don't poll again
    if (now - this.lastFocusTime < this.DEBOUNCE_TIME) {
      logger.info('Monitor: App focused, skipping poll (debounce active).');
      return;
    }

    logger.info('Monitor: App focused, triggering immediate poll...');
    this.lastFocusTime = now;

    // 3. Trigger Poll
    await this.poll().catch((e) => {
      logger.error('Monitor: Focus poll failed', e);
    });
    // 4. Reset the background interval so we don't double-poll shortly after
    this.resetInterval();
  }

  private static startInterval() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
    }
    this.intervalId = setInterval(() => {
      if (!this.isContinuousPollingEnabled()) {
        this.stop();
        return;
      }
      this.poll().catch((e) => logger.error('Scheduled poll failed', e));
    }, this.POLL_INTERVAL);
  }

  private static resetInterval() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.startInterval(); // Restart the 5-minute timer
    }
  }

  static async poll(): Promise<void> {
    if (!this.acceptingPolls) {
      throw new Error('Cloud monitor is shutting down');
    }
    this.stopped = false;
    cloudAccountWeeklyWarmupRunner.start();
    if (this.isContinuousPollingEnabled() && !this.intervalId) {
      this.startInterval();
    }

    if (this.activePollPromise) {
      return this.activePollPromise;
    }

    const pollPromise = this.executePoll();
    this.activePollPromise = pollPromise;

    try {
      await pollPromise;
    } finally {
      if (this.activePollPromise === pollPromise) {
        this.activePollPromise = null;
      }
    }
  }

  private static async executePoll(): Promise<void> {
    const epoch = this.stopEpoch;
    const refreshedAccounts: CloudAccount[] = [];
    logger.info('CloudMonitor: Polling quotas...');
    const accounts = await CloudAccountRepo.getAccounts();
    let now = Math.floor(Date.now() / 1000);

    for (const account of accounts) {
      try {
        if (account.health?.oauth?.refresh_blocked) {
          continue;
        }
        if (account.health?.validation && Date.now() < account.health.validation.next_probe_at_ms) {
          continue;
        }
        now = Math.floor(Date.now() / 1000);
        // 1. Check/Refresh Token if needed (give it a 10 min buffer here for safety)
        let accessToken = account.token.access_token;
        if (account.token.expiry_timestamp < now + 600) {
          if (!account.token.refresh_token) {
            if (account.token.expiry_timestamp <= now) {
              logger.warn(`Monitor: Token expired without refresh token for ${account.email}`);
              await CloudAccountRepo.setAccountStatus(
                account.id,
                'expired',
                'Access token expired and no refresh token is available',
              );
              continue;
            }

            logger.info(
              `Monitor: Token for ${account.email} is nearing expiry without a refresh token; using it until expiry`,
            );
          } else {
            logger.info(`Monitor: Refreshing token for ${account.email}`);
            try {
              const newToken = await CloudAccountRefreshService.refreshAccessToken(
                createCloudAccountRefreshRequest(account),
              );
              account.token = mergeRefreshedToken(account.token, newToken, now);
              await CloudAccountRepo.updateToken(account.id, account.token);
              accessToken = newToken.access_token;
            } catch (refreshError) {
              logger.error(`Monitor: Token refresh failed for ${account.email}`, refreshError);
              await persistMonitorAccountStatusFromError(account.id, refreshError);
              continue;
            }
          }
        }

        await delay(1000);

        let quota: QuotaData;
        const previousAICredits = account.quota?.ai_credits;

        try {
          const fetchedQuota = await GoogleAPIService.fetchQuota(accessToken, account.proxy_url);
          quota = { ...fetchedQuota };

          try {
            const aiCredits = await GoogleAPIService.fetchAICredits(accessToken, account.proxy_url);
            if (aiCredits) {
              quota.ai_credits = aiCredits;
            } else if (previousAICredits) {
              quota.ai_credits = previousAICredits;
            }
          } catch (creditError) {
            if (isUnauthorizedError(creditError) && account.token.refresh_token) {
              logger.warn(
                `Monitor: Received 401 Unauthorized while fetching credits for ${account.email}; forcing token refresh and retry`,
              );
              try {
                const refreshedToken = await CloudAccountRefreshService.refreshAccessToken(
                  createCloudAccountRefreshRequest(account),
                );
                now = Math.floor(Date.now() / 1000);
                account.token = mergeRefreshedToken(account.token, refreshedToken, now);
                await CloudAccountRepo.updateToken(account.id, account.token);
                accessToken = refreshedToken.access_token;

                const retriedAICredits = await GoogleAPIService.fetchAICredits(
                  accessToken,
                  account.proxy_url,
                );
                if (retriedAICredits) {
                  quota.ai_credits = retriedAICredits;
                } else if (previousAICredits) {
                  quota.ai_credits = previousAICredits;
                }
              } catch (retryError) {
                logger.warn(
                  `Monitor: Failed to fetch credits for ${account.email} after token refresh`,
                  retryError,
                );
                await persistMonitorAccountStatusFromError(account.id, retryError);
                if (previousAICredits) {
                  quota.ai_credits = previousAICredits;
                }
              }
            } else {
              logger.warn(`Monitor: Failed to fetch credits for ${account.email}`, creditError);
              if (previousAICredits) {
                quota.ai_credits = previousAICredits;
              }
            }
          }
        } catch (fetchError: unknown) {
          if (isUnauthorizedError(fetchError) && account.token.refresh_token) {
            logger.warn(
              `Monitor: Received 401 Unauthorized for ${account.email}; forcing token refresh and retry`,
            );
            const refreshedToken = await CloudAccountRefreshService.refreshAccessToken(
              createCloudAccountRefreshRequest(account),
            );
            now = Math.floor(Date.now() / 1000);
            account.token = mergeRefreshedToken(account.token, refreshedToken, now);
            await CloudAccountRepo.updateToken(account.id, account.token);
            accessToken = refreshedToken.access_token;

            const retriedQuota = await GoogleAPIService.fetchQuota(accessToken, account.proxy_url);
            quota = { ...retriedQuota };

            try {
              const aiCredits = await GoogleAPIService.fetchAICredits(
                accessToken,
                account.proxy_url,
              );
              if (aiCredits) {
                quota.ai_credits = aiCredits;
              } else if (previousAICredits) {
                quota.ai_credits = previousAICredits;
              }
            } catch (creditError) {
              logger.warn(
                `Monitor: Failed to fetch credits for ${account.email} after token refresh`,
                creditError,
              );
              if (previousAICredits) {
                quota.ai_credits = previousAICredits;
              }
            }
          } else {
            throw fetchError;
          }
        }

        // 3. Update DB & clear failures
        await CloudAccountRepo.updateQuota(account.id, quota);
        account.quota = quota;
        await CloudAccountRepo.setAccountStatus(account.id, 'active', null);
        await clearValidationHealthAfterSuccessfulProbe(account);
        account.status = 'active';
        account.status_reason = undefined;
        refreshedAccounts.push(account);
        proxyModelAvailabilityStore.clearCapabilityFailures(account.id);
      } catch (error) {
        logger.error(`Monitor: Failed to update ${account.email}`, error);
        await persistMonitorAccountStatusFromError(account.id, error);
        const classified = isRetryableInvalidGrantRefreshError(error)
          ? null
          : classifyAccountStatusFromError(error);
        if (classified) {
          if (classified.status === 'rate_limited' && hasReusableCachedQuota(account)) {
            logger.warn(
              `Monitor: Quota request rate-limited for ${account.email}, keeping cached quota as fallback.`,
            );
          }
        }
      }
    }

    try {
      this.effects.onQuotaUpdated(accounts);
    } catch {
      logger.warn('Cloud monitor presentation effect failed');
    }

    // 5. Check for Auto-Switch
    for (const target of resolveAutoSwitchTargets()) {
      try {
        await AutoSwitchService.checkAndSwitchIfNeeded(target);
      } catch (switchError) {
        // A switch failure is specific to one target and must not discard the quota results
        // already collected above, which the caller reports as a whole-poll failure.
        logger.error(`AutoSwitch: Failed to switch target ${target}`, switchError);
      }
    }
    if (epoch === this.stopEpoch) {
      await this.runWeeklyWarmups(refreshedAccounts);
    }
  }

  private static async runWeeklyWarmups(accounts: CloudAccount[]): Promise<void> {
    if (this.stopped) {
      return;
    }
    await cloudAccountWeeklyWarmupRunner.run(accounts);
  }
}
