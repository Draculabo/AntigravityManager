import { getCurrentAccountInfo } from '@/modules/account/public';
import { CloudAccountRepo } from '@/modules/cloud-account/persistence/cloudHandler';
import { CloudAccountSettingsStore } from '@/modules/cloud-account/persistence/cloud-account-settings-store';
import { resolveClientAccountStorage } from '@/modules/antigravity-runtime';
import { backfillMissingOAuthClientKeyForLegacyAccounts } from '@/modules/cloud-account/services/cloud-account-oauth-settings.service';
import {
  projectCloudAccountView,
  type CloudAccountView,
} from '@/modules/cloud-account/services/cloud-account-view';
import type { CloudAccount } from '@/modules/cloud-account/types';
import { logger } from '@/shared/logging/logger';
import { refreshAntigravityProcessCache } from '@/shared/platform/paths';

type ListTarget = 'classic' | 'ide';
type ActiveTarget = ListTarget | 'agy';

export interface CloudAccountListDependencies {
  getAccounts(): Promise<CloudAccount[]>;
  backfillOAuthClientKeys(accounts: CloudAccount[]): Promise<boolean>;
  refreshProcessCache(target: ListTarget): Promise<unknown>;
  getCurrentAccountInfo(
    target: ListTarget,
  ): Pick<ReturnType<typeof getCurrentAccountInfo>, 'isAuthenticated' | 'email'>;
  usesCredentialStore(target: 'classic'): boolean | Promise<boolean>;
  getActiveAccountId(target: ActiveTarget): string;
  warn(message: string, error: unknown): void;
}

function normalizeAccountEmail(email: string | undefined): string {
  return (email ?? '').trim().toLowerCase();
}

/** One list pipeline preserves target-state parity in embedded and standalone runtimes. */
export function createCloudAccountListService(deps: CloudAccountListDependencies) {
  return {
    async listViews(): Promise<CloudAccountView[]> {
      let accounts = await deps.getAccounts();
      const backfilled = await deps.backfillOAuthClientKeys(accounts);
      if (backfilled) {
        accounts = await deps.getAccounts();
      }

      await Promise.all([deps.refreshProcessCache('classic'), deps.refreshProcessCache('ide')]);

      let classicEmail = '';
      let ideEmail = '';
      try {
        const classicInfo = deps.getCurrentAccountInfo('classic');
        if (classicInfo.isAuthenticated) {
          classicEmail = normalizeAccountEmail(classicInfo.email);
        }
      } catch (error) {
        deps.warn('Failed to read current classic account info during listing', error);
      }
      const classicUsesCredentialStore = await deps.usesCredentialStore('classic');
      const activeClassicAccountId = classicUsesCredentialStore
        ? deps.getActiveAccountId('classic')
        : '';
      try {
        const ideInfo = deps.getCurrentAccountInfo('ide');
        if (ideInfo.isAuthenticated) {
          ideEmail = normalizeAccountEmail(ideInfo.email);
        }
      } catch (error) {
        deps.warn('Failed to read current ide account info during listing', error);
      }
      const activeIdeAccountId = ideEmail ? '' : deps.getActiveAccountId('ide');
      const activeAgyAccountId = deps.getActiveAccountId('agy');

      return accounts.map((account) => {
        const accountEmail = normalizeAccountEmail(account.email);
        const isClassicActive =
          classicUsesCredentialStore && activeClassicAccountId
            ? activeClassicAccountId === account.id
            : classicEmail === accountEmail;
        const isIdeActive =
          ideEmail === accountEmail || (!!activeIdeAccountId && activeIdeAccountId === account.id);
        const isAgyActive = activeAgyAccountId === account.id;
        return projectCloudAccountView({
          ...account,
          is_active: isClassicActive || isIdeActive || isAgyActive,
          is_active_classic: isClassicActive,
          is_active_ide: isIdeActive,
          is_active_agy: isAgyActive,
        });
      });
    },
  };
}

export const cloudAccountListService = createCloudAccountListService({
  getAccounts: () => CloudAccountRepo.getAccounts(),
  backfillOAuthClientKeys: backfillMissingOAuthClientKeyForLegacyAccounts,
  refreshProcessCache: (target) => refreshAntigravityProcessCache(target),
  getCurrentAccountInfo: (target) => getCurrentAccountInfo(target),
  usesCredentialStore: async (target) =>
    (await resolveClientAccountStorage(target)) === 'credential-store',
  getActiveAccountId: (target) => CloudAccountSettingsStore.getActiveAccountIdForTarget(target),
  warn: (message, error) => logger.warn(message, error),
});
