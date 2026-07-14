import { Notification } from 'electron';
import { CloudAccountRepo } from '@/modules/cloud-account/persistence/cloudHandler';
import { CloudAccountSettingsStore } from '@/modules/cloud-account/persistence/cloud-account-settings-store';
import { CloudAccount } from '@/modules/cloud-account/types';
import { switchCloudAccount } from '@/modules/cloud-account/ipc/handler';
import { logger } from '@/shared/logging/logger';
import { AntigravityAppTarget } from '@/modules/account/types';

export class AutoSwitchService {
  /**
   * Finds the best cloud account to switch to.
   * Criteria:
   * 1. Not the current account (unless it's the only one).
   * 2. Status is 'active'.
   * 3. Has quota > 5% for all enabled models.
   * 4. Sorted by priority models quota first, falling back to enabled models.
   */
  static async findBestAccount(currentAccountId: string): Promise<CloudAccount | null> {
    const accounts = await CloudAccountRepo.getAccounts();
    const config =
      CloudAccountSettingsStore.getSetting<Record<string, { enabled: boolean; priority: boolean }>>(
        'auto_switch_models',
        {},
      ) || {};

    // Filter potential candidates
    const candidates = accounts.filter((acc) => {
      if (acc.id === currentAccountId) return false;
      if (acc.status !== 'active') return false; // Rate limited or expired accounts are skipped
      if (!acc.quota) return false; // No quota data means risky

      return !this.isAccountDepleted(acc);
    });

    if (candidates.length === 0) return null;

    // Sort by "Best" score
    candidates.sort((a, b) => {
      const scoreA = this.calculateAccountScore(a, config);
      const scoreB = this.calculateAccountScore(b, config);
      return scoreB - scoreA; // Descending
    });

    return candidates[0];
  }

  private static calculateAccountScore(
    account: CloudAccount,
    config: Record<string, { enabled: boolean; priority: boolean }>,
  ): number {
    if (!account.quota?.models) return 0;

    const entries = Object.entries(account.quota.models);

    // 1. Get priority models that are enabled and exist in this account
    const priorityEntries = entries.filter(([modelId]) => {
      const modelConfig = config[modelId];
      return modelConfig?.enabled && modelConfig?.priority;
    });

    if (priorityEntries.length > 0) {
      const sum = priorityEntries.reduce((acc, [, m]) => acc + m.percentage, 0);
      return sum / priorityEntries.length;
    }

    // 2. Fall back to all enabled models
    const enabledEntries = entries.filter(([modelId]) => {
      const modelConfig = config[modelId];
      return modelConfig ? modelConfig.enabled : true;
    });

    if (enabledEntries.length > 0) {
      const sum = enabledEntries.reduce((acc, [, m]) => acc + m.percentage, 0);
      return sum / enabledEntries.length;
    }

    return 0;
  }

  /**
   * Triggered by Monitor Service or UI.
   * Checks if we need to switch from the current account.
   */
  static async checkAndSwitchIfNeeded(
    appTarget?: AntigravityAppTarget | undefined,
  ): Promise<boolean> {
    const enabled = CloudAccountSettingsStore.getSetting<boolean>('auto_switch_enabled', false);
    if (!enabled) return false;

    // Get current active account for the target
    const accounts = await CloudAccountRepo.getAccounts();
    const activeAccountId = CloudAccountSettingsStore.getActiveAccountIdForTarget(appTarget);
    const currentAccount = activeAccountId
      ? accounts.find((a) => a.id === activeAccountId)
      : accounts.find((a) => a.is_active);

    // If no active account, maybe we should pick one?
    if (!currentAccount) return false;

    // Check if current is depleted
    const isDepleted = this.isAccountDepleted(currentAccount);

    if (isDepleted || currentAccount.status === 'rate_limited') {
      logger.info(
        `AutoSwitch: Current account ${currentAccount.email} is depleted or rate limited.`,
      );

      const nextAccount = await this.findBestAccount(currentAccount.id);
      if (nextAccount) {
        logger.info(`AutoSwitch: Switching to ${nextAccount.email}...`);

        // Perform the switch
        await switchCloudAccount(nextAccount.id, appTarget);

        // Show Desktop Notification to alert the user of the switch
        try {
          new Notification({
            title: 'Antigravity Manager: Auto-Switch',
            body: `Switched account to ${nextAccount.email} due to quota limit. Reopen IDE and type "continue" if needed!`,
          }).show();
        } catch (err) {
          logger.error('Failed to show auto-switch desktop notification', err);
        }

        return true;
      } else {
        logger.warn('AutoSwitch: No healthy accounts available to switch to.');
      }
    }

    return false;
  }

  static isAccountDepleted(account: CloudAccount): boolean {
    if (!account.quota) return false;
    const THRESHOLD = 5;

    const config =
      CloudAccountSettingsStore.getSetting<Record<string, { enabled: boolean; priority: boolean }>>(
        'auto_switch_models',
        {},
      ) || {};

    const enabledModels = Object.entries(account.quota.models).filter(([modelId]) => {
      const modelConfig = config[modelId];
      return modelConfig ? modelConfig.enabled : true;
    });

    if (enabledModels.length === 0) {
      return false; // No enabled models, so not depleted
    }

    const anyModelDepleted = enabledModels.some(([, m]) => m.percentage < THRESHOLD);
    if (anyModelDepleted) {
      return true;
    }

    // Check quota groups
    const depletedGroups = (account.quota.quota_groups || []).filter((g) => {
      const lowestBucket = g.buckets.reduce(
        (min, b) => Math.min(min, b.remaining_fraction * 100),
        100,
      );
      return lowestBucket < THRESHOLD;
    });

    if (depletedGroups.length > 0) {
      const anyAffected = depletedGroups.some((group) => {
        const groupText = [group.display_name, group.description]
          .filter(Boolean)
          .join(' ')
          .toLowerCase();
        return enabledModels.some(([modelId]) => {
          const modelPart = modelId.split('-')[0].toLowerCase(); // 'claude' or 'gemini' etc.
          return groupText.includes(modelPart) || groupText.includes(modelId.toLowerCase());
        });
      });
      if (anyAffected) {
        return true;
      }
    }

    return false;
  }
}
