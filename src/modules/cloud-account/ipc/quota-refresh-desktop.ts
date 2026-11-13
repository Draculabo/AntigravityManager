import { refreshTrayAccount } from '@/modules/app-shell/ipc/tray/handler';
import { refreshAccountQuotaCore } from '@/modules/cloud-account/services/cloud-account-quota-refresh.service';
import { cloudAccountWeeklyWarmupRunner } from '@/modules/cloud-account/services/cloud-account-weekly-warmup-runner';
import type { CloudAccount } from '@/modules/cloud-account/types';

export function notifyTrayUpdate(): void {
  void refreshTrayAccount();
}

export async function refreshAccountQuotaForDesktop(accountId: string): Promise<CloudAccount> {
  const scheduleWarmup = (account: CloudAccount) =>
    cloudAccountWeeklyWarmupRunner.schedule([account]);
  const account = await refreshAccountQuotaCore(accountId, {
    onPrimarySuccess: scheduleWarmup,
    onRetrySuccess: scheduleWarmup,
  });
  notifyTrayUpdate();
  return account;
}
