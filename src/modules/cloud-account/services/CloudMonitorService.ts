import { Notification } from 'electron';
import { CloudAccountRepo } from '@/modules/cloud-account/persistence/cloudHandler';
import { CloudAccountSettingsStore } from '@/modules/cloud-account/persistence/cloud-account-settings-store';
import { GoogleAPIService, type QuotaData, type TokenResponse } from './GoogleAPIService';
import { AutoSwitchService } from './AutoSwitchService';
import { logger } from '@/shared/logging/logger';
import { classifyAccountStatusFromError } from '@/modules/cloud-account/utils/account-status';
import type { CloudAccount } from '@/modules/cloud-account/types';
import { AntigravityAppTargetSchema } from '@/shared/platform/antigravityAppTarget';
import type { AntigravityAppTarget } from '@/shared/platform/antigravityAppTarget';
import { hasAntigravityStorage } from '@/shared/platform/paths';
import { detectAgyCliExecutablePath } from '@/modules/antigravity-runtime/binary-patch/agyCliPathDetection';
import { ConfigManager } from '@/modules/config/ipc/manager';
import { proxyModelAvailabilityStore } from '@/modules/proxy-gateway/server/shared/services/model-availability.service';
import { WeeklyWarmupService } from './WeeklyWarmupService';
import type { WeeklyWarmupExecutor } from './weekly-warmup-contract';

type CloudMonitorLanguage = 'en' | 'zh-CN' | 'ru' | 'vi' | 'fr' | 'tr';

const CLOUD_MONITOR_NOTIFICATION_TEXT: Record<
  CloudMonitorLanguage,
  {
    lowQuotaTitle: string;
    lowQuotaBody: (email: string, models: string) => string;
    lowAICreditsTitle: string;
    lowAICreditsBody: (email: string, credits: number) => string;
  }
> = {
  en: {
    lowQuotaTitle: 'Low Quota Alert',
    lowQuotaBody: (email, models) => `${email}: ${models} are low on quota`,
    lowAICreditsTitle: 'Low AI Credits Alert',
    lowAICreditsBody: (email, credits) => `${email}: AI credits balance is low (${credits})`,
  },
  'zh-CN': {
    lowQuotaTitle: '额度不足提醒',
    lowQuotaBody: (email, models) => `${email}：${models} 的额度较低`,
    lowAICreditsTitle: 'AI 积分不足提醒',
    lowAICreditsBody: (email, credits) => `${email}：AI 积分余额不足（${credits}）`,
  },
  ru: {
    lowQuotaTitle: 'Предупреждение о низкой квоте',
    lowQuotaBody: (email, models) => `${email}: низкая квота у ${models}`,
    lowAICreditsTitle: 'Предупреждение о низком балансе AI-кредитов',
    lowAICreditsBody: (email, credits) => `${email}: низкий баланс AI-кредитов (${credits})`,
  },
  vi: {
    lowQuotaTitle: 'Cảnh báo quota thấp',
    lowQuotaBody: (email, models) => `${email}: ${models} đang có quota thấp`,
    lowAICreditsTitle: 'Cảnh báo số dư tín dụng AI thấp',
    lowAICreditsBody: (email, credits) => `${email}: số dư tín dụng AI thấp (${credits})`,
  },
  fr: {
    lowQuotaTitle: 'Alerte de quota faible',
    lowQuotaBody: (email, models) => `${email} : quota faible pour ${models}`,
    lowAICreditsTitle: 'Alerte de crédits IA faibles',
    lowAICreditsBody: (email, credits) => `${email} : solde de crédits IA faible (${credits})`,
  },
  tr: {
    lowQuotaTitle: 'Düşük Kota Uyarısı',
    lowQuotaBody: (email, models) => `${email}: ${models} için kota düşük`,
    lowAICreditsTitle: 'Düşük AI Kredisi Uyarısı',
    lowAICreditsBody: (email, credits) => `${email}: AI kredi bakiyesi düşük (${credits})`,
  },
};

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

/**
 * A target only participates in auto-switch when its switch can actually run: the desktop targets
 * need a storage.json on disk, and agy needs its CLI binary. Resolving this per poll keeps an
 * absent install from failing the switch (desktop targets throw storage_json_not_found).
 */
function resolveAutoSwitchTargets(): AntigravityAppTarget[] {
  return AUTO_SWITCH_CANDIDATE_TARGETS.filter((target) =>
    target === 'agy' ? isAgyCliInstalled() : hasAntigravityStorage(target),
  );
}

function getCloudMonitorLanguage(language: string | null | undefined): CloudMonitorLanguage {
  const normalizedLanguage = language?.toLowerCase() ?? 'en';
  if (normalizedLanguage.startsWith('zh')) {
    return 'zh-CN';
  }
  if (normalizedLanguage.startsWith('ru')) {
    return 'ru';
  }
  if (normalizedLanguage.startsWith('vi')) {
    return 'vi';
  }
  if (normalizedLanguage.startsWith('fr')) {
    return 'fr';
  }
  if (normalizedLanguage.startsWith('tr')) {
    return 'tr';
  }
  return 'en';
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
  private static intervalId: NodeJS.Timeout | null = null;
  private static POLL_INTERVAL = 1000 * 60 * 5; // 5 minutes
  private static DEBOUNCE_TIME = 10000; // 10 seconds
  private static lastFocusTime: number = 0;
  private static activePollPromise: Promise<void> | null = null;
  private static weeklyWarmupExecutor: WeeklyWarmupExecutor | null = null;
  private static stopped = false;
  private static stopEpoch = 0;

  private static isAutoSwitchEnabled(): boolean {
    return CloudAccountSettingsStore.getSetting<boolean>('auto_switch_enabled', false);
  }

  static configureWeeklyWarmupExecutor(executor: WeeklyWarmupExecutor): void {
    this.weeklyWarmupExecutor = executor;
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
    WeeklyWarmupService.resetStateForTesting();
    this.lastFocusTime = 0;
    this.activePollPromise = null;
    this.weeklyWarmupExecutor = null;
    this.stop();
  }

  static start() {
    if (this.intervalId) return;
    logger.info('Starting CloudMonitorService...');

    // Set lastFocusTime to now to prevent "double-dip" on startup (focus event immediately after start)
    this.lastFocusTime = Date.now();

    // Initial Poll
    this.poll().catch((e) => logger.error('Initial poll failed', e));

    this.startInterval();
  }

  static stop() {
    this.stopped = true;
    this.stopEpoch++;
    WeeklyWarmupService.cancel();
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      logger.info('Stopped CloudMonitorService');
    }
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
    this.stopped = false;
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
              const newToken = await GoogleAPIService.refreshAccessToken(
                account.token.refresh_token,
                account.proxy_url,
                account.token.oauth_client_key,
              );
              account.token = mergeRefreshedToken(account.token, newToken, now);
              await CloudAccountRepo.updateToken(account.id, account.token);
              accessToken = newToken.access_token;
            } catch (refreshError) {
              logger.error(`Monitor: Token refresh failed for ${account.email}`, refreshError);
              const classified = classifyAccountStatusFromError(refreshError);
              if (classified) {
                await CloudAccountRepo.setAccountStatus(
                  account.id,
                  classified.status,
                  classified.reason,
                );
              }
              continue;
            }
          }
        }

        await new Promise((r) => setTimeout(r, 1000));

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
                const refreshedToken = await GoogleAPIService.refreshAccessToken(
                  account.token.refresh_token,
                  account.proxy_url,
                  account.token.oauth_client_key,
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
            const refreshedToken = await GoogleAPIService.refreshAccessToken(
              account.token.refresh_token,
              account.proxy_url,
              account.token.oauth_client_key,
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
        account.status = 'active';
        account.status_reason = undefined;
        refreshedAccounts.push(account);
        proxyModelAvailabilityStore.clearCapabilityFailures(account.id);
      } catch (error) {
        logger.error(`Monitor: Failed to update ${account.email}`, error);
        const classified = classifyAccountStatusFromError(error);
        if (classified) {
          await CloudAccountRepo.setAccountStatus(account.id, classified.status, classified.reason);
          if (classified.status === 'rate_limited' && hasReusableCachedQuota(account)) {
            logger.warn(
              `Monitor: Quota request rate-limited for ${account.email}, keeping cached quota as fallback.`,
            );
          }
        }
      }
    }

    // 4. Check for Quota Alerts
    const alertEnabled = CloudAccountSettingsStore.getSetting<boolean>(
      'quota_alert_enabled',
      false,
    );
    const alertThreshold = CloudAccountSettingsStore.getSetting<number>(
      'quota_alert_threshold',
      20,
    );
    const notificationLanguage = getCloudMonitorLanguage(
      CloudAccountSettingsStore.getSetting<string>('language', 'en'),
    );
    const notificationText = CLOUD_MONITOR_NOTIFICATION_TEXT[notificationLanguage];

    if (alertEnabled) {
      for (const account of accounts) {
        if (!account.quota?.models) continue;
        const lowQuotaModels = Object.entries(account.quota.models)
          .filter(([_, info]) => info.percentage >= 0 && info.percentage <= alertThreshold)
          .map(([name, info]) => {
            return info.display_name || name.replace('models/', '').replace(/-/g, ' ');
          });

        if (lowQuotaModels.length > 0) {
          new Notification({
            title: notificationText.lowQuotaTitle,
            body: notificationText.lowQuotaBody(account.email, lowQuotaModels.join(', ')),
            silent: false,
          }).show();
        }
      }
    }

    // Check for AI Credits Alerts
    const aiCreditsAlertEnabled = CloudAccountSettingsStore.getSetting<boolean>(
      'ai_credits_alert_enabled',
      false,
    );
    const aiCreditsAlertThreshold = CloudAccountSettingsStore.getSetting<number>(
      'ai_credits_alert_threshold',
      5000,
    );

    if (aiCreditsAlertEnabled) {
      for (const account of accounts) {
        const credits = account.quota?.ai_credits?.credits;
        if (credits === undefined || credits > aiCreditsAlertThreshold) {
          continue;
        }

        new Notification({
          title: notificationText.lowAICreditsTitle,
          body: notificationText.lowAICreditsBody(account.email, credits),
          silent: false,
        }).show();
      }
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

  /** The caller supplies only accounts whose quota/token refresh just succeeded. */
  static scheduleWeeklyWarmup(accounts: CloudAccount[]): void {
    this.runWeeklyWarmups(accounts).catch(() => {
      logger.warn('Weekly warmup refresh could not complete');
    });
  }

  private static async runWeeklyWarmups(accounts: CloudAccount[]): Promise<void> {
    if (this.stopped || !WeeklyWarmupService.isEnabled()) {
      return;
    }
    if (!this.weeklyWarmupExecutor) {
      logger.warn('Weekly warmup is enabled, but no executor is configured');
      return;
    }

    const warmedAccountIds = await WeeklyWarmupService.run(accounts, this.weeklyWarmupExecutor);
    for (const accountId of warmedAccountIds) {
      if (this.stopped) {
        break;
      }
      const account = accounts.find((candidate) => candidate.id === accountId);
      if (!account) {
        continue;
      }
      try {
        const refreshedQuota = await GoogleAPIService.fetchQuota(
          account.token.access_token,
          account.proxy_url,
        );
        account.quota = {
          ...refreshedQuota,
          ai_credits: refreshedQuota.ai_credits ?? account.quota?.ai_credits,
        };
        await CloudAccountRepo.updateQuota(account.id, account.quota);
      } catch {
        logger.warn(`Failed to refresh quota after weekly warmup for account=${account.id}`);
      }
    }
  }
}
