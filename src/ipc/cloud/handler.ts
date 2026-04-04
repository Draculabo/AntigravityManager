import { v4 as uuidv4 } from 'uuid';
import { CloudAccountRepo } from '../../ipc/database/cloudHandler';
import { GoogleAPIService } from '../../services/GoogleAPIService';
import { CloudAccount, CloudAccountExportSchema } from '../../types/cloudAccount';
import { logger } from '../../utils/logger';
import { AuthServer } from './authServer';

import { shell } from 'electron';
import fs from 'fs';
import { updateTrayMenu } from '../../ipc/tray/handler';
import {
  ensureGlobalOriginalFromCurrentStorage,
  generateDeviceProfile,
  getStorageDirectoryPath,
  isIdentityProfileApplyEnabled,
  loadGlobalOriginalProfile,
  readCurrentDeviceProfile,
  saveGlobalOriginalProfile,
} from '../../ipc/device/handler';
import { getAntigravityDbPaths } from '../../utils/paths';
import { runWithSwitchGuard } from '../../ipc/switchGuard';
import { executeSwitchFlow } from '../../ipc/switchFlow';
import type { DeviceProfile, DeviceProfilesSnapshot } from '../../types/account';

// Fallback constants if service constants are not available or for direct usage
const CLIENT_ID = '1071006060591-tmhssin21lcre235vtolojh4g403ep.apps.googleusercontent.com';
const SCOPE = [
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/cclog',
  'https://www.googleapis.com/auth/experimentsandconfigs',
].join(' ');

// Helper to update tray
function notifyTrayUpdate(account: CloudAccount) {
  try {
    // Fetch language setting. Default to 'en' if not set.

    const lang = CloudAccountRepo.getSetting<string>('language', 'en');
    updateTrayMenu(account, lang);
  } catch (e) {
    logger.warn('Failed to update tray', e);
  }
}

export async function addGoogleAccount(authCode: string): Promise<CloudAccount> {
  try {
    // 1. Exchange code for tokens
    const tokenResp = await GoogleAPIService.exchangeCode(authCode);

    // 2. Get User Info
    const userInfo = await GoogleAPIService.getUserInfo(tokenResp.access_token);

    // 3. Check for existing account
    const existing = await CloudAccountRepo.getAccountByEmail(userInfo.email);
    if (existing) {
      throw new Error(`Account with email ${userInfo.email} already exists.`);
    }

    // 4. Construct CloudAccount Object
    const now = Math.floor(Date.now() / 1000);
    const account: CloudAccount = {
      id: uuidv4(),
      provider: 'google',
      email: userInfo.email,
      name: userInfo.name || userInfo.email,
      avatar_url: userInfo.picture,
      token: {
        access_token: tokenResp.access_token,
        refresh_token: tokenResp.refresh_token || '',
        expires_in: tokenResp.expires_in,
        expiry_timestamp: now + tokenResp.expires_in,
        token_type: tokenResp.token_type,
        email: userInfo.email,
      },
      created_at: now,
      last_used: now,
    };

    if (!account.token.refresh_token) {
      logger.warn(`No refresh token received for ${account.email}. Account will expire in 1 hour.`);
    }

    await CloudAccountRepo.addAccount(account);

    try {
      const quota = await GoogleAPIService.fetchQuota(account.token.access_token);
      account.quota = quota;
      await CloudAccountRepo.updateQuota(account.id, quota);
      notifyTrayUpdate(account);
    } catch (e) {
      logger.warn('Failed to fetch initial quota', e);
    }

    return account;
  } catch (error) {
    logger.error('Failed to add Google account', error);
    throw error;
  }
}

export async function listCloudAccounts(): Promise<CloudAccount[]> {
  return CloudAccountRepo.getAccounts();
}

export async function deleteCloudAccount(accountId: string): Promise<void> {
  await CloudAccountRepo.removeAccount(accountId);
}

export async function refreshAccountQuota(accountId: string): Promise<CloudAccount> {
  const account = await CloudAccountRepo.getAccount(accountId);
  if (!account) {
    throw new Error(`Account not found: ${accountId}`);
  }

  let now = Math.floor(Date.now() / 1000);
  if (account.token.expiry_timestamp < now + 300) {
    logger.info(`Token for ${account.email} near expiry, refreshing...`);
    try {
      const newTokenData = await GoogleAPIService.refreshAccessToken(
        account.token.refresh_token,
        account.proxy_url,
      );

      account.token.access_token = newTokenData.access_token;
      account.token.expires_in = newTokenData.expires_in;
      account.token.expiry_timestamp = now + newTokenData.expires_in;

      await CloudAccountRepo.updateToken(account.id, account.token);
    } catch (e) {
      logger.error(`Failed to refresh token during time-check for ${account.email}`, e);
      throw new Error(`Token refresh failed for ${account.email}. Please try logging in again.`);
    }
  }

  try {
    const quota = await GoogleAPIService.fetchQuota(account.token.access_token, account.proxy_url);
    account.quota = quota;
    await CloudAccountRepo.updateQuota(account.id, quota);

    try {
      const aiCredits = await GoogleAPIService.fetchAICredits(
        account.token.access_token,
        account.proxy_url,
      );
      if (aiCredits) {
        account.quota = { ...quota, ai_credits: aiCredits };
        await CloudAccountRepo.updateQuota(account.id, account.quota);
      }
    } catch (e) {
      logger.warn('Failed to fetch AI credits', e);
    }

    await CloudAccountRepo.updateLastUsed(account.id);
    account.last_used = Math.floor(Date.now() / 1000);
    notifyTrayUpdate(account);
    return account;
  } catch (error: any) {
    if (error.message === 'UNAUTHORIZED') {
      logger.warn(`Got 401 Unauthorized for ${account.email}, forcing token refresh...`);
      try {
        const newTokenData = await GoogleAPIService.refreshAccessToken(
          account.token.refresh_token,
          account.proxy_url,
        );
        now = Math.floor(Date.now() / 1000);

        account.token.access_token = newTokenData.access_token;
        account.token.expires_in = newTokenData.expires_in;
        account.token.expiry_timestamp = now + newTokenData.expires_in;

        await CloudAccountRepo.updateToken(account.id, account.token);

        const quota = await GoogleAPIService.fetchQuota(
          account.token.access_token,
          account.proxy_url,
        );
        account.quota = quota;
        await CloudAccountRepo.updateQuota(account.id, quota);

        try {
          const aiCredits = await GoogleAPIService.fetchAICredits(
            account.token.access_token,
            account.proxy_url,
          );
          if (aiCredits) {
            account.quota = { ...quota, ai_credits: aiCredits };
            await CloudAccountRepo.updateQuota(account.id, account.quota);
          }
        } catch (e) {
          logger.warn('Failed to fetch AI credits after token refresh', e);
        }

        await CloudAccountRepo.updateLastUsed(account.id);
        account.last_used = Math.floor(Date.now() / 1000);
        return account;
      } catch (refreshError) {
        logger.error(
          `Failed to force refresh token or retry quota for ${account.email}`,
          refreshError,
        );
        throw refreshError;
      }
    } else if (error.message === 'FORBIDDEN') {
      logger.warn(
        `Got 403 Forbidden for ${account.email}, marking as rate limited (if implemented) or just ignoring.`,
      );
      return account;
    }

    logger.error(`Failed to refresh quota for ${account.email}`, error);
    throw error;
  }
}

export async function switchCloudAccount(accountId: string): Promise<void> {
  await runWithSwitchGuard('cloud-account-switch', async () => {
    try {
      const account = await CloudAccountRepo.getAccount(accountId);
      if (!account) {
        throw new Error(`Account not found: ${accountId}`);
      }

      logger.info(`Switching to cloud account: ${account.email} (${account.id})`);

      ensureGlobalOriginalFromCurrentStorage();
      if (!account.device_profile) {
        const generated = generateDeviceProfile();
        CloudAccountRepo.setDeviceBinding(account.id, generated, 'auto_generated');
        saveGlobalOriginalProfile(generated);
        account.device_profile = generated;
      }

      // 1. Prepare token refresh promise (start it in parallel with process exit)
      const tokenRefreshPromise = (async () => {
        const now = Math.floor(Date.now() / 1000);
        if (account.token.expiry_timestamp < now + 1200) {
          logger.info(`Token for ${account.email} near expiry, refreshing in parallel...`);
          try {
            const newTokenData = await GoogleAPIService.refreshAccessToken(
              account.token.refresh_token,
              account.proxy_url,
            );

            const updatedToken = {
              ...account.token,
              access_token: newTokenData.access_token,
              expires_in: newTokenData.expires_in,
              expiry_timestamp: now + newTokenData.expires_in,
            };
            await CloudAccountRepo.updateToken(account.id, updatedToken);

            account.token = updatedToken;
            logger.info(`Token refreshed for ${account.email}`);
          } catch (e) {
            logger.warn('Failed to refresh token in parallel, will try to use existing', e);
          }
        }
      })();

      await executeSwitchFlow({
        scope: 'cloud',
        targetProfile: account.device_profile || null,
        applyFingerprint: isIdentityProfileApplyEnabled(),
        processExitTimeoutMs: 10000,
        performSwitch: async () => {
          // Wait for token refresh to complete before injection if it was started
          await tokenRefreshPromise;

          // 3. Backup Database (Optimized to avoid race conditions)
          const dbPaths = getAntigravityDbPaths();
          for (const dbPath of dbPaths) {
            try {
              const backupPath = `${dbPath}.backup`;
              await fs.promises.copyFile(dbPath, backupPath);
              logger.info(`Backed up database to ${backupPath}`);
              break; // Success, stop trying other paths
            } catch (e: any) {
              // If file not found, just try the next path
              if (e.code === 'ENOENT') continue;
              logger.error(`Failed to backup database at ${dbPath}`, e);
            }
          }

          // 4. Inject Token
          CloudAccountRepo.injectCloudToken(account);

          // 5. Update usage and active status
          CloudAccountRepo.updateLastUsed(account.id);
          CloudAccountRepo.setActive(account.id);

          logger.info(`Successfully switched to cloud account: ${account.email}`);
          notifyTrayUpdate(account);
        },
      });
    } catch (err: any) {
      logger.error('Failed to switch cloud account', err);
      throw new Error(`Switch failed: ${err.message || 'Unknown error'}`);
    }
  });
}

export async function getCloudIdentityProfiles(accountId: string): Promise<DeviceProfilesSnapshot> {
  const account = await CloudAccountRepo.getAccount(accountId);
  if (!account) {
    throw new Error(`Account not found: ${accountId}`);
  }

  let currentStorage: DeviceProfile | undefined;
  try {
    currentStorage = readCurrentDeviceProfile();
  } catch (error) {
    logger.warn('Failed to read current storage device profile', error);
  }

  return {
    currentStorage,
    boundProfile: account.device_profile,
    history: account.device_history || [],
    baseline: loadGlobalOriginalProfile() || undefined,
  };
}

export async function previewGenerateCloudIdentityProfile(): Promise<DeviceProfile> {
  return generateDeviceProfile();
}

export async function bindCloudIdentityProfile(
  accountId: string,
  mode: 'capture' | 'generate',
): Promise<DeviceProfile> {
  const account = await CloudAccountRepo.getAccount(accountId);
  if (!account) {
    throw new Error(`Account not found: ${accountId}`);
  }

  let profile: DeviceProfile;
  if (mode === 'capture') {
    profile = readCurrentDeviceProfile();
  } else {
    profile = generateDeviceProfile();
  }

  ensureGlobalOriginalFromCurrentStorage();
  saveGlobalOriginalProfile(profile);
  CloudAccountRepo.setDeviceBinding(account.id, profile, mode);

  return profile;
}

export async function bindCloudIdentityProfileWithPayload(
  accountId: string,
  profile: DeviceProfile,
): Promise<DeviceProfile> {
  const account = await CloudAccountRepo.getAccount(accountId);
  if (!account) {
    throw new Error(`Account not found: ${accountId}`);
  }

  ensureGlobalOriginalFromCurrentStorage();
  saveGlobalOriginalProfile(profile);
  CloudAccountRepo.setDeviceBinding(account.id, profile, 'generated');

  return profile;
}

export async function restoreCloudIdentityProfileRevision(
  accountId: string,
  versionId: string,
): Promise<DeviceProfile> {
  const baseline = loadGlobalOriginalProfile();
  return CloudAccountRepo.restoreDeviceVersion(accountId, versionId, baseline);
}

export async function restoreCloudBaselineProfile(accountId: string): Promise<DeviceProfile> {
  const baseline = loadGlobalOriginalProfile();
  if (!baseline) {
    throw new Error('Global original profile not found');
  }
  return CloudAccountRepo.restoreDeviceVersion(accountId, 'baseline', baseline);
}

export async function deleteCloudIdentityProfileRevision(
  accountId: string,
  versionId: string,
): Promise<void> {
  CloudAccountRepo.deleteDeviceVersion(accountId, versionId);
}

export async function openCloudIdentityStorageFolder(): Promise<void> {
  const directory = getStorageDirectoryPath();
  const result = await shell.openPath(directory);
  if (result) {
    throw new Error(`Failed to open identity storage: ${result}`);
  }
}

export function getAutoSwitchEnabled(): boolean {
  return CloudAccountRepo.getSetting<boolean>('auto_switch_enabled', false);
}

export async function setAutoSwitchEnabled(enabled: boolean): Promise<void> {
  CloudAccountRepo.setSetting('auto_switch_enabled', enabled);
  // Trigger an immediate check if enabled
  if (enabled) {
    const { CloudMonitorService } = await import('../../services/CloudMonitorService');
    CloudMonitorService.poll().catch((err: any) =>
      logger.error('Failed to poll after enabling auto-switch', err),
    );
  }
}

export async function forcePollCloudMonitor(): Promise<void> {
  const { CloudMonitorService } = await import('../../services/CloudMonitorService');
  await CloudMonitorService.poll();
}

export async function startAuthFlow(): Promise<void> {
  const url = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${CLIENT_ID}&redirect_uri=${AuthServer.getRedirectUri()}&response_type=code&scope=${SCOPE}&access_type=offline&prompt=consent&include_granted_scopes=true`;

  logger.info(`Starting auth flow, opening URL: ${url}`);
  await shell.openExternal(url);
}

export async function exportCloudAccounts(stripTokens = false): Promise<string> {
  const accounts = await CloudAccountRepo.getAccounts();
  const exportData = {
    version: '1.0' as const,
    exportedAt: Math.floor(Date.now() / 1000),
    accounts: accounts.map((acc) => ({
      provider: acc.provider,
      email: acc.email,
      name: acc.name,
      avatar_url: acc.avatar_url,
      token: stripTokens ? undefined : acc.token,
      quota: acc.quota,
      device_profile: acc.device_profile,
      device_history: acc.device_history,
      proxy_url: acc.proxy_url ?? null,
    })),
  };

  CloudAccountExportSchema.parse(exportData);
  return JSON.stringify(exportData, null, 2);
}

export type ImportStrategy = 'merge' | 'overwrite' | 'skip-existing';

export async function importCloudAccounts(
  jsonContent: string,
  strategy: ImportStrategy = 'merge',
): Promise<{ imported: number; skipped: number; updated: number; errors: string[] }> {
  const result = { imported: 0, skipped: 0, updated: 0, errors: [] as string[] };

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonContent);
  } catch {
    throw new Error('Invalid JSON format');
  }

  const validated = CloudAccountExportSchema.safeParse(parsed);
  if (!validated.success) {
    throw new Error(
      `Invalid export file: ${validated.error.issues[0]?.message || 'schema mismatch'}`,
    );
  }

  const importEmails = new Set<string>();
  for (const acc of validated.data.accounts) {
    const emailLower = acc.email.toLowerCase();
    if (importEmails.has(emailLower)) {
      throw new Error(`Duplicate email found in import file: ${acc.email}`);
    }
    importEmails.add(emailLower);
  }

  const existingAccounts = await CloudAccountRepo.getAccounts();
  const existingByEmail = new Map(existingAccounts.map((a) => [a.email.toLowerCase(), a]));

  for (const acc of validated.data.accounts) {
    try {
      const existing = existingByEmail.get(acc.email.toLowerCase());
      const now = Math.floor(Date.now() / 1000);

      if (existing) {
        if (strategy === 'skip-existing') {
          result.skipped++;
          continue;
        }

        const updatedAccount: CloudAccount = {
          ...existing,
          provider: acc.provider,
          name: acc.name ?? existing.name,
          avatar_url: acc.avatar_url ?? existing.avatar_url,
          token: acc.token,
          quota: acc.quota ?? existing.quota,
          device_profile: acc.device_profile ?? existing.device_profile,
          device_history: acc.device_history ?? existing.device_history,
          proxy_url: acc.proxy_url ?? existing.proxy_url,
          last_used: now,
        };

        await CloudAccountRepo.addAccount(updatedAccount);
        result.updated++;
      } else {
        const newAccount: CloudAccount = {
          id: uuidv4(),
          provider: acc.provider,
          email: acc.email,
          name: acc.name,
          avatar_url: acc.avatar_url,
          token: acc.token,
          quota: acc.quota,
          device_profile: acc.device_profile,
          device_history: acc.device_history,
          proxy_url: acc.proxy_url ?? undefined,
          created_at: now,
          last_used: now,
          status: 'active',
          is_active: false,
        };

        await CloudAccountRepo.addAccount(newAccount);
        result.imported++;
      }
    } catch (error: any) {
      result.errors.push(`Failed to import ${acc.email}: ${error.message}`);
    }
  }

  return result;
}
