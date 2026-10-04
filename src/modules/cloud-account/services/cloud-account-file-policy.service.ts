import { v4 as uuidv4 } from 'uuid';
import { prepareDesktopIdentityStorage } from '@/modules/identity-profile/public';
import { z } from 'zod';
import { CloudAccountRepo } from '../persistence/cloudHandler';
import { CloudAccountExportSchema, type CloudAccount } from '../types';
import { isOAuthReauthReason } from '../utils/account-status';
import { CloudAccountRefreshService } from './CloudAccountRefreshService';
import { localAccountPostImportService } from '../local-import/local-account-post-import.service';
import { CloudAccountFileError } from './cloud-account-file.error';
import {
  CLOUD_ACCOUNT_IMPORT_MAX_ERRORS,
  type ImportStrategy,
  type CloudAccountImportSummary,
} from './cloud-account-file.schema';

/**
 * An imported access-token snapshot is not proof of reauthorization: exports intentionally
 * include it, so accepting the same refresh grant again must not lift a durable OAuth block.
 */
function replacesRefreshGrant(
  currentToken: CloudAccount['token'],
  importedToken: CloudAccount['token'] | undefined,
): boolean {
  if (!importedToken) {
    return false;
  }

  const importedRefreshToken = importedToken.refresh_token.trim();
  return importedRefreshToken !== '' && importedRefreshToken !== currentToken.refresh_token.trim();
}

export async function exportCloudAccounts(stripTokens = false): Promise<string> {
  const accounts = await CloudAccountRepo.getAccounts();
  const exportData = {
    version: '1.0' as const,
    exportedAt: Math.floor(Date.now() / 1000),
    accounts: accounts.map((account) => ({
      provider: account.provider,
      email: account.email,
      name: account.name,
      avatar_url: account.avatar_url,
      token: stripTokens ? undefined : account.token,
      quota: account.quota,
      device_profile: account.device_profile,
      device_history: account.device_history,
      proxy_url: account.proxy_url ?? null,
      status: account.status,
      status_reason: account.status_reason,
    })),
  };

  CloudAccountExportSchema.parse(exportData);
  return JSON.stringify(exportData, null, 2);
}

export async function importCloudAccounts(
  jsonContent: string,
  strategy: ImportStrategy = 'merge',
): Promise<CloudAccountImportSummary> {
  const result: CloudAccountImportSummary = {
    imported: 0,
    skipped: 0,
    updated: 0,
    failed: 0,
    errors: [],
  };
  const importedIds: string[] = [];
  const recordFailure = (
    email: string,
    code: CloudAccountImportSummary['errors'][number]['code'],
  ) => {
    result.failed++;
    if (result.errors.length < CLOUD_ACCOUNT_IMPORT_MAX_ERRORS) {
      const safeEmail = z.email().max(320).safeParse(email);
      result.errors.push({ code, ...(safeEmail.success ? { email: safeEmail.data } : {}) });
    }
  };

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonContent);
  } catch {
    throw new CloudAccountFileError('invalid-export');
  }

  const validated = CloudAccountExportSchema.safeParse(parsed);
  if (!validated.success) {
    throw new CloudAccountFileError('invalid-export');
  }

  const importEmails = new Set<string>();
  for (const importedAccount of validated.data.accounts) {
    const emailLower = importedAccount.email.toLowerCase();
    if (importEmails.has(emailLower)) {
      throw new CloudAccountFileError('invalid-export');
    }
    importEmails.add(emailLower);
  }

  await prepareDesktopIdentityStorage();
  const existingAccounts = await CloudAccountRepo.getAccounts();
  const existingByEmail = new Map(existingAccounts.map((a) => [a.email.toLowerCase(), a]));

  for (const importedAccount of validated.data.accounts) {
    try {
      const existing = existingByEmail.get(importedAccount.email.toLowerCase());
      const now = Math.floor(Date.now() / 1000);

      if (existing) {
        if (strategy === 'skip-existing') {
          result.skipped++;
          continue;
        }

        const replacesStoredRefreshGrant = replacesRefreshGrant(
          existing.token,
          importedAccount.token,
        );
        const preservesBlockedAccountStatus =
          !replacesStoredRefreshGrant && existing.health?.oauth?.refresh_blocked === true;
        const shouldResetOAuthStatus =
          replacesStoredRefreshGrant &&
          existing.status === 'expired' &&
          isOAuthReauthReason(existing.status_reason ?? '');
        const recoveredHealth = existing.health?.validation
          ? { validation: existing.health.validation }
          : undefined;
        const updatedAccount: CloudAccount = {
          ...existing,
          provider: importedAccount.provider,
          name: importedAccount.name ?? existing.name,
          avatar_url: importedAccount.avatar_url ?? existing.avatar_url,
          token: importedAccount.token ?? existing.token,
          quota: importedAccount.quota ?? existing.quota,
          health: replacesStoredRefreshGrant ? recoveredHealth : existing.health,
          device_profile: importedAccount.device_profile ?? existing.device_profile,
          device_history: importedAccount.device_history ?? existing.device_history,
          proxy_url: importedAccount.proxy_url ?? existing.proxy_url,
          status: shouldResetOAuthStatus
            ? 'active'
            : preservesBlockedAccountStatus
              ? existing.status
              : (importedAccount.status ?? existing.status),
          status_reason: shouldResetOAuthStatus
            ? undefined
            : preservesBlockedAccountStatus
              ? existing.status_reason
              : (importedAccount.status_reason ?? existing.status_reason),
        };

        await CloudAccountRepo.addAccount(updatedAccount);
        if (replacesStoredRefreshGrant) {
          await CloudAccountRefreshService.clearFailureState(existing.id);
        }
        result.updated++;
        importedIds.push(existing.id);
      } else {
        if (!importedAccount.token) {
          recordFailure(importedAccount.email, 'tokens-missing');
          continue;
        }

        const newAccount: CloudAccount = {
          id: uuidv4(),
          provider: importedAccount.provider,
          email: importedAccount.email,
          name: importedAccount.name,
          avatar_url: importedAccount.avatar_url,
          token: importedAccount.token,
          quota: importedAccount.quota,
          device_profile: importedAccount.device_profile,
          device_history: importedAccount.device_history,
          proxy_url: importedAccount.proxy_url ?? undefined,
          created_at: now,
          last_used: now,
          status: importedAccount.status ?? 'active',
          status_reason: importedAccount.status_reason,
          is_active: false,
        };

        await CloudAccountRepo.addAccount(newAccount);
        result.imported++;
        importedIds.push(newAccount.id);
      }
    } catch {
      recordFailure(importedAccount.email, 'account-write-failed');
    }
  }

  localAccountPostImportService.schedule(importedIds);
  return result;
}
