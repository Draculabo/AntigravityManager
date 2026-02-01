import { CloudAccountRepo } from '../ipc/database/cloudHandler';
import { CloudAccount } from '../types/cloudAccount';
import { switchCloudAccount } from '../ipc/cloud/handler';
import { logger } from '../utils/logger';
import { NotificationService } from './NotificationService';

export class AutoSwitchService {
  /**
   * Find best account to switch to based on quota and status.
   */
  static async findBestAccount(currentAccountId: string): Promise<CloudAccount | null> {
    const accounts = await CloudAccountRepo.getAccounts();
    const switchThreshold = NotificationService.getSwitchThreshold();

    const candidates = accounts.filter((acc) => {
      if (acc.id === currentAccountId) return false;
      if (acc.status !== 'active') return false;
      if (!acc.quota) return false;

      const models = Object.values(acc.quota.models);
      const isDepleted = models.some((m) => m.percentage < switchThreshold);
      return !isDepleted;
    });

    if (candidates.length === 0) return null;

    candidates.sort((a, b) => {
      return this.calculateAverageQuota(b) - this.calculateAverageQuota(a);
    });

    return candidates[0];
  }

  private static calculateAverageQuota(account: CloudAccount): number {
    if (!account.quota) return 0;
    const values = Object.values(account.quota.models).map((m) => m.percentage);
    if (values.length === 0) return 0;
    return values.reduce((a, b) => a + b, 0) / values.length;
  }

  /**
   * Check if current account is depleted and switch if needed.
   */
  static async checkAndSwitchIfNeeded(): Promise<boolean> {
    const enabled = CloudAccountRepo.getSetting<boolean>('auto_switch_enabled', false);
    if (!enabled) return false;

    const accounts = await CloudAccountRepo.getAccounts();
    const currentAccount = accounts.find((a) => a.is_active);
    if (!currentAccount) return false;

    const isDepleted = this.isAccountDepleted(currentAccount);

    if (isDepleted || currentAccount.status === 'rate_limited') {
      logger.info(`AutoSwitch: ${currentAccount.email} is depleted or rate limited.`);

      const nextAccount = await this.findBestAccount(currentAccount.id);
      if (nextAccount) {
        logger.info(`AutoSwitch: Switching to ${nextAccount.email}...`);
        await switchCloudAccount(nextAccount.id);
        NotificationService.sendAutoSwitchNotification(currentAccount.email, nextAccount.email);
        return true;
      } else {
        logger.warn('AutoSwitch: No healthy accounts available.');
        NotificationService.sendAllDepletedNotification();
      }
    }

    return false;
  }

  static isAccountDepleted(account: CloudAccount): boolean {
    if (!account.quota) return false;
    const threshold = NotificationService.getSwitchThreshold();
    return Object.values(account.quota.models).some((m) => m.percentage < threshold);
  }
}
