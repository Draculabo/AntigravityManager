import { z } from 'zod';
import { updateTrayMenu } from '@/modules/app-shell/ipc/tray/handler';
import { CloudAccountSettingsStore } from '@/modules/cloud-account/persistence/cloud-account-settings-store';
import { refreshAccountQuotaCore } from '@/modules/cloud-account/services/cloud-account-quota-refresh.service';
import { cloudAccountWeeklyWarmupRunner } from '@/modules/cloud-account/services/cloud-account-weekly-warmup-runner';
import type { CloudAccount } from '@/modules/cloud-account/types';
import { logger } from '@/shared/logging/logger';

export function notifyTrayUpdate(account: CloudAccount): void {
  try {
    const language = CloudAccountSettingsStore.getSetting('language', 'en', z.string());
    updateTrayMenu(account, language);
  } catch (error) {
    logger.warn('Failed to update tray after cloud account update', error);
  }
}

export async function refreshAccountQuotaForDesktop(accountId: string): Promise<CloudAccount> {
  return refreshAccountQuotaCore(accountId, {
    onPrimarySuccess: (account) => {
      notifyTrayUpdate(account);
      cloudAccountWeeklyWarmupRunner.schedule([account]);
    },
    onRetrySuccess: (account) => {
      cloudAccountWeeklyWarmupRunner.schedule([account]);
    },
  });
}
