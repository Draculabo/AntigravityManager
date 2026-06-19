import { Notification } from 'electron';
import { CloudAccountRepo } from '@/modules/cloud-account/persistence/cloudHandler';
import { GoogleAPIService, type TokenResponse } from './GoogleAPIService';
import { AutoSwitchService } from './AutoSwitchService';
import { logger } from '@/shared/logging/logger';
import { classifyAccountStatusFromError } from '@/modules/cloud-account/utils/account-status';
import type { CloudAccount } from '@/modules/cloud-account/types';
import { AntigravityAppTargetSchema } from '@/modules/account/types';
import type { AntigravityAppTarget } from '@/modules/account/types';

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

const AUTO_SWITCH_TARGETS: AntigravityAppTarget[] = AntigravityAppTargetSchema.options.filter(
  (target) => target !== 'agy',
);

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
  private static isPolling: boolean = false;

  // Helper for testing
  static resetStateForTesting() {
    this.lastFocusTime = 0;
    this.isPolling = false;
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
    if (this.isPolling) {
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
      this.poll().catch((e) => logger.error('Scheduled poll failed', e));
    }, this.POLL_INTERVAL);
  }

  private static resetInterval() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.startInterval(); // Restart the 5-minute timer
    }
  }

  static async poll() {
    if (this.isPolling) {
      return; // Extra safety
    }
    this.isPolling = true;

    try {
      logger.info('CloudMonitor: Polling quotas...');
      const accounts = await CloudAccountRepo.getAccounts();
      const now = Math.floor(Date.now() / 1000);

      for (const account of accounts) {
        try {
          // 1. Check/Refresh Token if needed (give it a 10 min buffer here for safety)
          let accessToken = account.token.access_token;
          if (account.token.expiry_timestamp < now + 600) {
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

          await new Promise((r) => setTimeout(r, 1000));
          const quota = await GoogleAPIService.fetchQuota(accessToken, account.proxy_url);
          const previousAICredits = account.quota?.ai_credits;

          try {
            const aiCredits = await GoogleAPIService.fetchAICredits(accessToken, account.proxy_url);
            if (aiCredits) {
              quota.ai_credits = aiCredits;
            } else if (previousAICredits) {
              quota.ai_credits = previousAICredits;
            }
          } catch (creditError) {
            logger.warn(`Monitor: Failed to fetch credits for ${account.email}`, creditError);
            if (previousAICredits) {
              quota.ai_credits = previousAICredits;
            }
          }

          // 3. Update DB
          await CloudAccountRepo.updateQuota(account.id, quota);
          await CloudAccountRepo.updateLastUsed(account.id);
          await CloudAccountRepo.setAccountStatus(account.id, 'active', null);
        } catch (error) {
          logger.error(`Monitor: Failed to update ${account.email}`, error);
          const classified = classifyAccountStatusFromError(error);
          if (classified) {
            await CloudAccountRepo.setAccountStatus(
              account.id,
              classified.status,
              classified.reason,
            );
            if (classified.status === 'rate_limited' && hasReusableCachedQuota(account)) {
              logger.warn(
                `Monitor: Quota request rate-limited for ${account.email}, keeping cached quota as fallback.`,
              );
            }
          }
        }
      }

      // 4. Check for Quota Alerts
      const alertEnabled = CloudAccountRepo.getSetting<boolean>('quota_alert_enabled', false);
      const alertThreshold = CloudAccountRepo.getSetting<number>('quota_alert_threshold', 20);
      const notificationLanguage = getCloudMonitorLanguage(
        CloudAccountRepo.getSetting<string>('language', 'en'),
      );
      const notificationText = CLOUD_MONITOR_NOTIFICATION_TEXT[notificationLanguage];

      if (alertEnabled) {
        for (const account of accounts) {
          if (!account.quota?.models) continue;
          const lowQuotaModels = Object.entries(account.quota.models)
            .filter(([_, info]) => info.percentage <= alertThreshold && info.percentage > 0)
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

      // 5. Check for Auto-Switch
      for (const target of AUTO_SWITCH_TARGETS) {
        await AutoSwitchService.checkAndSwitchIfNeeded(target);
      }
    } finally {
      this.isPolling = false;
    }
  }
}
