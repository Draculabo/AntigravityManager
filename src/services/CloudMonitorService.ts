import { CloudAccountRepo } from '../ipc/database/cloudHandler';
import { GoogleAPIService } from './GoogleAPIService';
import { AutoSwitchService } from './AutoSwitchService';
import { NotificationService } from './NotificationService';
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

    // Initial Poll - skip auto-switch on startup to avoid killing Antigravity immediately
    // User may have just opened Manager while Antigravity is running
    this.poll(true).catch((e) => logger.error('Initial poll failed', e));

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

  static async poll(skipAutoSwitch = false) {
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
            const newToken = await GoogleAPIService.refreshAccessToken(account.token.refresh_token);
            account.token.access_token = newToken.access_token;
            account.token.expires_in = newToken.expires_in;
            account.token.expiry_timestamp = now + newToken.expires_in;
            await CloudAccountRepo.updateToken(account.id, account.token);
            accessToken = newToken.access_token;
          }

          // 2. Fetch Quota
          // We delay slightly between requests to act human/avoid spike
          await new Promise((r) => setTimeout(r, 1000));
          const quota = await GoogleAPIService.fetchQuota(accessToken);

          // 3. Update DB
          await CloudAccountRepo.updateQuota(account.id, quota);
          await CloudAccountRepo.updateLastUsed(account.id);

          // 4. Check for quota warning notification
          const warningThreshold = NotificationService.getWarningThreshold();
          const switchThreshold = NotificationService.getSwitchThreshold();
          const avgQuota = this.calculateAverageQuota(quota);

          // Only warn if above switch threshold (not yet critical) but below warning threshold
          if (avgQuota < warningThreshold && avgQuota >= switchThreshold) {
            NotificationService.sendQuotaWarningNotification(account.email, avgQuota);
          }
        } catch (error) {
          logger.error(`Monitor: Failed to update ${account.email}`, error);
          // Could mark status as 'error' or 'rate_limited' if 429
        }
      }

      // 4. Check for Auto-Switch (skip on initial startup to avoid killing Antigravity immediately)
      if (!skipAutoSwitch) {
        await AutoSwitchService.checkAndSwitchIfNeeded();
      } else {
        logger.info('CloudMonitor: Skipping auto-switch on initial poll');
      }
    } finally {
      this.isPolling = false;
    }
  }

  /**
   * Calculate average quota percentage across all models
   */
  private static calculateAverageQuota(quota: { models: Record<string, { percentage: number }> }): number {
    const values = Object.values(quota.models).map((m) => m.percentage);
    if (values.length === 0) return 100; // Assume full if no data
    const sum = values.reduce((a, b) => a + b, 0);
    return sum / values.length;
  }
}
