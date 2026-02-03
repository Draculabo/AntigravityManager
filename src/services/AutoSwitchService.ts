import { CloudAccountRepo } from '../ipc/database/cloudHandler';
import { CloudAccount } from '../types/cloudAccount';
import { switchCloudAccount } from '../ipc/cloud/handler';
import { logger } from '../utils/logger';
import { NotificationService } from './NotificationService';
import { calculateAverageQuota, isQuotaDepleted } from '../utils/quota';

export class AutoSwitchService {
  /**
   * Find best account to switch to based on quota and status.
   */
  static async findBestAccount(currentAccountId: string): Promise<CloudAccount | null> {
    const accounts = await CloudAccountRepo.getAccounts();
    const switchThreshold = await NotificationService.getSwitchThresholdAsync();

    const candidates = accounts.filter((acc) => {
      if (acc.id === currentAccountId) return false;
      if (acc.status !== 'active') return false;
      if (!acc.quota) return false;

      const models = Object.values(acc.quota.models);
      if (models.length === 0) return false; // Exclude if no models data available

      const isDepleted = models.some((m) => m.percentage < switchThreshold);
      return !isDepleted;
    });

    if (candidates.length === 0) return null;

    candidates.sort((a, b) => {
      return calculateAverageQuota(b.quota) - calculateAverageQuota(a.quota);
    });

    return candidates[0];
  }

  /**
   * Check if current account is depleted and switch if needed.
   * @returns true if a switch was successfully performed, false otherwise.
   */
  static async checkAndSwitchIfNeeded(): Promise<boolean> {
    const enabled = await CloudAccountRepo.getSettingAsync<boolean>('auto_switch_enabled', false);
    if (!enabled) return false;

    const accounts = await CloudAccountRepo.getAccounts();
    const currentAccount = accounts.find((a) => a.is_active);
    if (!currentAccount) return false;

    const isDepleted = await this.isAccountDepletedAsync(currentAccount);

    if (isDepleted || currentAccount.status === 'rate_limited') {
      logger.info(`AutoSwitch: ${currentAccount.email} is depleted or rate limited.`);

      const nextAccount = await this.findBestAccount(currentAccount.id);
      if (nextAccount) {
        logger.info(`AutoSwitch: Switching to ${nextAccount.email}...`);

        try {
          await switchCloudAccount(nextAccount.id);
          NotificationService.sendAutoSwitchNotification(currentAccount.email, nextAccount.email);
          logger.info(`AutoSwitch: Successfully switched from ${currentAccount.email} to ${nextAccount.email}`);
          return true;
        } catch (error) {
          logger.error('AutoSwitch: Failed to switch accounts', error);
          // Attempt to notify user about the failure
          try {
            NotificationService.sendSwitchFailedNotification(currentAccount.email, nextAccount.email, error);
          } catch {
            // Ignore notification errors in fallback
          }
          return false;
        }
      } else {
        logger.warn('AutoSwitch: No healthy accounts available.');
        NotificationService.sendAllDepletedNotification();
      }
    }

    return false;
  }

  static async isAccountDepletedAsync(account: CloudAccount): Promise<boolean> {
    const threshold = await NotificationService.getSwitchThresholdAsync();
    return isQuotaDepleted(account.quota, threshold);
  }
}
