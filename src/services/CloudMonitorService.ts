import { CloudAccountRepo } from '../ipc/database/cloudHandler';
import { GoogleAPIService } from './GoogleAPIService';
import { AutoSwitchService } from './AutoSwitchService';
import { NotificationService } from './NotificationService';
import { CloudAccountService } from './CloudAccountService';
import { logger } from '../utils/logger';
import { calculateAverageQuota } from '../utils/quota';

export class CloudMonitorService {
  private static intervalId: NodeJS.Timeout | null = null;
  private static POLL_INTERVAL = 1000 * 60 * 5;
  private static DEBOUNCE_TIME = 10000;
  private static lastFocusTime: number = 0;
  private static isPolling: boolean = false;

  static resetStateForTesting() {
    this.lastFocusTime = 0;
    this.isPolling = false;
    this.stop();
  }

  static start() {
    if (this.intervalId) return;
    logger.info('Starting CloudMonitorService...');

    this.lastFocusTime = Date.now();
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

  static async handleAppFocus() {
    const now = Date.now();

    if (this.isPolling) {
      logger.info('Monitor: Polling in progress, skipping focus poll.');
      return;
    }

    if (now - this.lastFocusTime < this.DEBOUNCE_TIME) {
      logger.info('Monitor: Debounce active, skipping poll.');
      return;
    }

    logger.info('Monitor: App focused, triggering poll...');
    this.lastFocusTime = now;

    await this.poll().catch((e) => logger.error('Focus poll failed', e));
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
    this.startInterval();
  }

  static async poll(skipAutoSwitch = false) {
    if (this.isPolling) return;
    this.isPolling = true;

    try {
      logger.info('CloudMonitor: Polling quotas...');
      const accounts = await CloudAccountRepo.getAccounts();
      const now = Math.floor(Date.now() / 1000);

      // Fetch thresholds once per poll
      const [warningThreshold, switchThreshold] = await Promise.all([
        NotificationService.getWarningThresholdAsync(),
        NotificationService.getSwitchThresholdAsync(),
      ]);

      for (const account of accounts) {
        try {
          const nowNow = Math.floor(Date.now() / 1000);
          if (account.token.expiry_timestamp < nowNow + 600) {
            await CloudAccountService.refreshAndSaveToken(account);
          }

          // Small delay to avoid heavy burst of requests
          await new Promise((r) => setTimeout(r, 500));
          const quota = await GoogleAPIService.fetchQuota(account.token.access_token);

          await CloudAccountRepo.updateQuota(account.id, quota);

          const avgQuota = calculateAverageQuota(quota);

          if (avgQuota < warningThreshold && avgQuota >= switchThreshold) {
            NotificationService.sendQuotaWarningNotification(account.email, avgQuota);
          }
        } catch (error) {
          logger.error(`Monitor: Failed to update ${account.email}`, error);
        }
      }

      if (!skipAutoSwitch) {
        await AutoSwitchService.checkAndSwitchIfNeeded();
      } else {
        logger.info('CloudMonitor: Skipping auto-switch on initial poll');
      }
    } finally {
      this.isPolling = false;
    }
  }


}
