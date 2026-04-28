import { v4 as uuidv4 } from 'uuid';
import { CloudAccountRepo } from '../../ipc/database/cloudHandler';
import { GoogleAPIService, type OAuthClientDescriptor } from '../../services/GoogleAPIService';
import { CloudAccount, CloudAccountExportSchema } from '../../types/cloudAccount';
import { logger } from '../../utils/logger';

import { shell } from 'electron';
import fs from 'fs';
import { isEmpty, isString } from 'lodash-es';
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
import { classifyAccountStatusFromError, extractErrorMessage } from '../../utils/account-status';

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

const ACTIVE_OAUTH_CLIENT_KEY_SETTING = 'active_oauth_client_key';
const OAUTH_CLIENT_KEY_BACKFILL_DONE_SETTING = 'oauth_client_key_backfill_v1_done';
const ENTERPRISE_OAUTH_CLIENT_KEY = 'antigravity_enterprise';

function isEnterpriseClient(clientKey?: string): boolean {
  if (!clientKey) {
    return false;
  }
  return clientKey.trim().toLowerCase() === ENTERPRISE_OAUTH_CLIENT_KEY;
}

function normalizeProjectId(projectId?: string): string | null {
  if (!isString(projectId)) {
    return null;
  }
  const normalized = projectId.trim();
  return normalized === '' ? null : normalized;
}

function recoverCachedQuotaOnRateLimit(
  account: CloudAccount,
  error: unknown,
): CloudAccount['quota'] | null {
  const classified = classifyAccountStatusFromError(error);
  if (!classified || classified.status !== 'rate_limited') {
    return null;
  }
  if (!account.quota || !account.quota.models || Object.keys(account.quota.models).length === 0) {
    return null;
  }
  return account.quota;
}

function formatSwitchRefreshError(reason: string): string {
  const normalized = reason.toLowerCase();
  if (
    normalized.includes('unauthorized_client') ||
    normalized.includes('invalid_client') ||
    normalized.includes('invalid_grant')
  ) {
    return `Token refresh failed: OAuth client is not authorized for this account. Please re-login and complete authorization. Raw error: ${reason}`;
  }
  if (
    normalized.includes('verify your account') ||
    normalized.includes('further action is required') ||
    normalized.includes('validation required') ||
    normalized.includes('validation_url') ||
    normalized.includes('appeal_url')
  ) {
    return `Token refresh failed: account requires additional verification. Please finish verification and retry. Raw error: ${reason}`;
  }
  if (
    normalized.includes('resource_exhausted') ||
    normalized.includes('resource has been exhausted')
  ) {
    return `Token refresh failed: account is rate-limited or temporarily restricted (RESOURCE_EXHAUSTED). Please retry later. Raw error: ${reason}`;
  }
  return `Token refresh failed: ${reason}`;
}

async function ensureEnterpriseProjectReady(account: CloudAccount): Promise<void> {
  if (!isEnterpriseClient(account.token.oauth_client_key)) {
    return;
  }

  if (normalizeProjectId(account.token.project_id)) {
    return;
  }

  logger.warn(
    `[OAuth] Account ${account.email} is using enterprise OAuth client but missing project_id. Resolving before switch...`,
  );

  let resolvedProjectId: string | null = null;
  try {
    resolvedProjectId = await GoogleAPIService.fetchProjectId(
      account.token.access_token,
      account.proxy_url,
    );
  } catch (error) {
    throw new Error(
      `Account ${account.email} cannot be switched safely: missing enterprise project_id and auto-resolve failed (${extractErrorMessage(
        error,
      )}). Please re-login with a non-enterprise OAuth client or a project-enabled token.`,
    );
  }

  const normalizedProjectId = normalizeProjectId(resolvedProjectId ?? undefined);
  if (!normalizedProjectId) {
    throw new Error(
      `Account ${account.email} cannot be switched safely: enterprise OAuth requires a valid project_id.`,
    );
  }

  account.token.project_id = normalizedProjectId;
  await CloudAccountRepo.updateToken(account.id, account.token);
}

async function markAccountStatusFromError(account: CloudAccount, error: unknown): Promise<void> {
  const classified = classifyAccountStatusFromError(error);
  if (!classified) {
    return;
  }

  account.status = classified.status;
  account.status_reason = classified.reason;
  await CloudAccountRepo.setAccountStatus(account.id, classified.status, classified.reason);
}

async function clearAccountStatus(account: CloudAccount): Promise<void> {
  account.status = 'active';
  account.status_reason = undefined;
  await CloudAccountRepo.setAccountStatus(account.id, 'active', null);
}

function hydrateActiveOAuthClientFromSettings(): void {
  const preferredClientKey = CloudAccountRepo.getSetting<string>(
    ACTIVE_OAUTH_CLIENT_KEY_SETTING,
    '',
  );
  if (isString(preferredClientKey) && !isEmpty(preferredClientKey.trim())) {
    try {
      GoogleAPIService.setActiveOAuthClientKey(preferredClientKey);
    } catch (error) {
      logger.warn(
        `[OAuth] Stored active OAuth client '${preferredClientKey}' is invalid, falling back to default`,
        error,
      );
      CloudAccountRepo.setSetting(ACTIVE_OAUTH_CLIENT_KEY_SETTING, '');
    }
  }
}

async function backfillMissingOAuthClientKeyForLegacyAccounts(
  accounts: CloudAccount[],
): Promise<boolean> {
  const backfillDone = CloudAccountRepo.getSetting<boolean>(
    OAUTH_CLIENT_KEY_BACKFILL_DONE_SETTING,
    false,
  );
  if (backfillDone) {
    return false;
  }

  hydrateActiveOAuthClientFromSettings();
  const activeClientKey = GoogleAPIService.getActiveOAuthClientKey().trim().toLowerCase();
  if (activeClientKey === '') {
    return false;
  }

  let updatedCount = 0;
  let skippedEnterpriseGuardCount = 0;
  let hasFailure = false;

  for (const account of accounts) {
    if (account.provider !== 'google') {
      continue;
    }

    const currentClientKey = account.token.oauth_client_key?.trim();
    if (currentClientKey) {
      continue;
    }

    const refreshToken = account.token.refresh_token?.trim();
    if (!refreshToken) {
      continue;
    }

    const projectMissing =
      !isString(account.token.project_id) || isEmpty(account.token.project_id.trim());
    if (activeClientKey === ENTERPRISE_OAUTH_CLIENT_KEY && projectMissing) {
      skippedEnterpriseGuardCount += 1;
      continue;
    }

    try {
      await CloudAccountRepo.updateToken(account.id, {
        ...account.token,
        oauth_client_key: activeClientKey,
      });
      updatedCount += 1;
    } catch (error) {
      hasFailure = true;
      logger.warn(
        `[OAuth] Failed to backfill oauth_client_key for account ${account.email} (${account.id})`,
        error,
      );
    }
  }

  if (!hasFailure) {
    CloudAccountRepo.setSetting(OAUTH_CLIENT_KEY_BACKFILL_DONE_SETTING, true);
  }

  logger.info(
    `[OAuth] Backfill oauth_client_key completed: updated=${updatedCount}, skipped_enterprise_guard=${skippedEnterpriseGuardCount}, has_failure=${hasFailure}`,
  );

  return updatedCount > 0;
}

export async function addGoogleAccount(
  authCode: string,
  oauthClientKey?: string,
): Promise<CloudAccount> {
  try {
    if (isString(oauthClientKey) && !isEmpty(oauthClientKey.trim())) {
      setActiveOAuthClient(oauthClientKey);
    } else {
      hydrateActiveOAuthClientFromSettings();
    }

    // 1. Exchange code for tokens
    const tokenResp = await GoogleAPIService.exchangeCode(authCode, undefined, oauthClientKey);

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
        oauth_client_key: tokenResp.oauth_client_key,
        is_gcp_tos: true,
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
      try {
        const aiCredits = await GoogleAPIService.fetchAICredits(
          account.token.access_token,
          undefined,
        );
        if (aiCredits) {
          quota.ai_credits = aiCredits;
        } else {
          logger.info(`No AI credits returned for ${account.email} during initial sync`);
        }
      } catch (e) {
        logger.warn('Failed to fetch initial AI credits', e);
      }
      account.quota = quota;
      await CloudAccountRepo.updateQuota(account.id, account.quota);
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
  const accounts = await CloudAccountRepo.getAccounts();
  const backfilled = await backfillMissingOAuthClientKeyForLegacyAccounts(accounts);
  if (backfilled) {
    return CloudAccountRepo.getAccounts();
  }
  return accounts;
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
        account.token.oauth_client_key,
      );

      account.token.access_token = newTokenData.access_token;
      account.token.expires_in = newTokenData.expires_in;
      account.token.expiry_timestamp = now + newTokenData.expires_in;
      account.token.oauth_client_key = GoogleAPIService.normalizeRefreshedOAuthClientKey(
        account.token,
        newTokenData.oauth_client_key,
      );

      await CloudAccountRepo.updateToken(account.id, account.token);
    } catch (e) {
      logger.error(`Failed to refresh token during time-check for ${account.email}`, e);
      await markAccountStatusFromError(account, e);
      throw new Error(`Token refresh failed for ${account.email}. Please try logging in again.`);
    }
  }

  try {
    const previousAICredits = account.quota?.ai_credits;
    const quota = await GoogleAPIService.fetchQuota(account.token.access_token, account.proxy_url);

    try {
      const aiCredits = await GoogleAPIService.fetchAICredits(
        account.token.access_token,
        account.proxy_url,
      );
      if (aiCredits) {
        quota.ai_credits = aiCredits;
      } else {
        logger.info(`No AI credits returned for ${account.email} during quota refresh`);
        if (previousAICredits) {
          quota.ai_credits = previousAICredits;
        }
      }
    } catch (e) {
      logger.warn('Failed to fetch AI credits', e);
      if (previousAICredits) {
        quota.ai_credits = previousAICredits;
      }
    }

    account.quota = quota;
    await CloudAccountRepo.updateQuota(account.id, account.quota);
    await CloudAccountRepo.updateLastUsed(account.id);
    account.last_used = Math.floor(Date.now() / 1000);
    await clearAccountStatus(account);
    notifyTrayUpdate(account);
    return account;
  } catch (error: any) {
    if (error.message === 'UNAUTHORIZED') {
      logger.warn(`Got 401 Unauthorized for ${account.email}, forcing token refresh...`);
      try {
        const newTokenData = await GoogleAPIService.refreshAccessToken(
          account.token.refresh_token,
          account.proxy_url,
          account.token.oauth_client_key,
        );
        now = Math.floor(Date.now() / 1000);

        account.token.access_token = newTokenData.access_token;
        account.token.expires_in = newTokenData.expires_in;
        account.token.expiry_timestamp = now + newTokenData.expires_in;
        account.token.oauth_client_key = GoogleAPIService.normalizeRefreshedOAuthClientKey(
          account.token,
          newTokenData.oauth_client_key,
        );

        await CloudAccountRepo.updateToken(account.id, account.token);

        const previousAICredits = account.quota?.ai_credits;
        const quota = await GoogleAPIService.fetchQuota(
          account.token.access_token,
          account.proxy_url,
        );

        try {
          const aiCredits = await GoogleAPIService.fetchAICredits(
            account.token.access_token,
            account.proxy_url,
          );
          if (aiCredits) {
            quota.ai_credits = aiCredits;
          } else {
            logger.info(`No AI credits returned for ${account.email} after token refresh`);
            if (previousAICredits) {
              quota.ai_credits = previousAICredits;
            }
          }
        } catch (e) {
          logger.warn('Failed to fetch AI credits after token refresh', e);
          if (previousAICredits) {
            quota.ai_credits = previousAICredits;
          }
        }

        account.quota = quota;
        await CloudAccountRepo.updateQuota(account.id, account.quota);
        await CloudAccountRepo.updateLastUsed(account.id);
        account.last_used = Math.floor(Date.now() / 1000);
        await clearAccountStatus(account);
        return account;
      } catch (refreshError) {
        logger.error(
          `Failed to force refresh token or retry quota for ${account.email}`,
          refreshError,
        );
        const cachedQuota = recoverCachedQuotaOnRateLimit(account, refreshError);
        if (cachedQuota) {
          logger.warn(
            `[OAuth] Quota request is rate-limited for ${account.email}; reusing cached quota as fallback.`,
          );
          await markAccountStatusFromError(account, refreshError);
          return account;
        }
        await markAccountStatusFromError(account, refreshError);
        throw refreshError;
      }
    } else if (error.message === 'FORBIDDEN') {
      logger.warn(
        `Got 403 Forbidden for ${account.email}, marking as rate limited (if implemented) or just ignoring.`,
      );
      await markAccountStatusFromError(account, error);
      return account;
    }

    const cachedQuota = recoverCachedQuotaOnRateLimit(account, error);
    if (cachedQuota) {
      logger.warn(
        `[OAuth] Quota request is rate-limited for ${account.email}; reusing cached quota as fallback.`,
      );
      await markAccountStatusFromError(account, error);
      return account;
    }

    await markAccountStatusFromError(account, error);
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

      const tokenRefreshPromise = (async () => {
        const now = Math.floor(Date.now() / 1000);
        if (!isString(account.token.refresh_token) || isEmpty(account.token.refresh_token.trim())) {
          logger.warn(
            `Token for ${account.email} has no refresh token; switched IDE session may expire without recovery.`,
          );
          return;
        }

        logger.info(`Refreshing token for ${account.email} before IDE injection...`);
        try {
          const newTokenData = await GoogleAPIService.refreshAccessToken(
            account.token.refresh_token,
            account.proxy_url,
            account.token.oauth_client_key,
          );

          const updatedToken = {
            ...account.token,
            access_token: newTokenData.access_token,
            expires_in: newTokenData.expires_in,
            expiry_timestamp: now + newTokenData.expires_in,
            token_type: newTokenData.token_type,
            oauth_client_key: GoogleAPIService.normalizeRefreshedOAuthClientKey(
              account.token,
              newTokenData.oauth_client_key,
            ),
          };
          await CloudAccountRepo.updateToken(account.id, updatedToken);

          account.token = updatedToken;
          logger.info(`Token refreshed for ${account.email}`);
        } catch (e) {
          logger.warn('Failed to refresh token before IDE injection', e);
          await markAccountStatusFromError(account, e);
          const reason = extractErrorMessage(e);
          throw new Error(formatSwitchRefreshError(reason));
        }
      })();

      await tokenRefreshPromise;
      await ensureEnterpriseProjectReady(account);

      await executeSwitchFlow({
        scope: 'cloud',
        targetProfile: account.device_profile || null,
        applyFingerprint: isIdentityProfileApplyEnabled(),
        processExitTimeoutMs: 10000,
        performSwitch: async () => {
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
          await clearAccountStatus(account);

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

export async function startAuthFlow(oauthClientKey?: string): Promise<void> {
  if (isString(oauthClientKey) && !isEmpty(oauthClientKey.trim())) {
    setActiveOAuthClient(oauthClientKey);
  } else {
    hydrateActiveOAuthClientFromSettings();
  }
  const url = GoogleAPIService.getAuthUrl(oauthClientKey);

  logger.info(`Starting auth flow, opening URL: ${url}`);
  await shell.openExternal(url);
}

export function listOAuthClients(): OAuthClientDescriptor[] {
  hydrateActiveOAuthClientFromSettings();
  return GoogleAPIService.listOAuthClients();
}

export function getActiveOAuthClient(): string {
  hydrateActiveOAuthClientFromSettings();
  return GoogleAPIService.getActiveOAuthClientKey();
}

export function setActiveOAuthClient(clientKey: string): void {
  GoogleAPIService.setActiveOAuthClientKey(clientKey);
  CloudAccountRepo.setSetting(
    ACTIVE_OAUTH_CLIENT_KEY_SETTING,
    GoogleAPIService.getActiveOAuthClientKey(),
  );
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
      status: acc.status,
      status_reason: acc.status_reason,
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
          status: acc.status ?? existing.status,
          status_reason: acc.status_reason ?? existing.status_reason,
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
          status: acc.status ?? 'active',
          status_reason: acc.status_reason,
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
