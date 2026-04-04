import { Notification } from 'electron';
import { CloudAccountRepo } from '../ipc/database/cloudHandler';
import { GoogleAPIService } from './GoogleAPIService';
import { AutoSwitchService } from './AutoSwitchService';
import { logger } from '../utils/logger';

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
              );
              account.token.access_token = newToken.access_token;
              account.token.expires_in = newToken.expires_in;
              account.token.expiry_timestamp = now + newToken.expires_in;
              await CloudAccountRepo.updateToken(account.id, account.token);
              accessToken = newToken.access_token;
            } catch (refreshError) {
              logger.error(`Monitor: Token refresh failed for ${account.email}`, refreshError);
              continue;
            }
          }

          await new Promise((r) => setTimeout(r, 1000));
          const quota = await GoogleAPIService.fetchQuota(accessToken, account.proxy_url);

          try {
            const aiCredits = await GoogleAPIService.fetchAICredits(accessToken, account.proxy_url);
            if (aiCredits) {
              quota.ai_credits = aiCredits;
            }
          } catch (creditError) {
            logger.warn(`Monitor: Failed to fetch credits for ${account.email}`, creditError);
          }

          // 3. Update DB
          await CloudAccountRepo.updateQuota(account.id, quota);
          await CloudAccountRepo.updateLastUsed(account.id);
        } catch (error) {
          logger.error(`Monitor: Failed to update ${account.email}`, error);
          // Could mark status as 'error' or 'rate_limited' if 429
        }
      }

      // 4. Check for Quota Alerts
      const alertEnabled = CloudAccountRepo.getSetting<boolean>('quota_alert_enabled', false);
      const alertThreshold = CloudAccountRepo.getSetting<number>('quota_alert_threshold', 20);

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
              title: 'Low Quota Alert',
              body: `${account.email}: ${lowQuotaModels.join(', ')} are low on quota`,
              silent: false,
            }).show();
          }
        }
      }

      // 5. Check for Auto-Switch
      await AutoSwitchService.checkAndSwitchIfNeeded();
    } finally {
      this.isPolling = false;
    }
  }
}
