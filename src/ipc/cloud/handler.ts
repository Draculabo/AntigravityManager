import { v4 as uuidv4 } from 'uuid';
import { CloudAccountRepo } from '../../ipc/database/cloudHandler';
import { GoogleAPIService } from '../../services/GoogleAPIService';
import { CloudAccount } from '../../types/cloudAccount';
import { logger } from '../../utils/logger';

import { shell } from 'electron';
import fs from 'fs';
import { closeAntigravity, startAntigravity, _waitForProcessExit } from '../../ipc/process/handler';
import { updateTrayMenu } from '../../ipc/tray/handler';
import { getAntigravityDbPaths } from '../../utils/paths';

// Fallback constants if service constants are not available or for direct usage
const CLIENT_ID = '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com';
const REDIRECT_URI = 'http://localhost:8888/oauth-callback';
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

    // 3. Construct CloudAccount Object
    const now = Math.floor(Date.now() / 1000);
    const account: CloudAccount = {
      id: uuidv4(),
      provider: 'google',
      email: userInfo.email,
      name: userInfo.name || userInfo.email,
      avatar_url: userInfo.picture,
      token: {
        access_token: tokenResp.access_token,
        refresh_token: tokenResp.refresh_token || '', // prompt=consent guarantees this, but we fallback safely
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

    // 4. Save to DB
    await CloudAccountRepo.addAccount(account);

    // 5. Initial Quota Check (Async, best effort)
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

  // Check if token needs refresh
  let now = Math.floor(Date.now() / 1000);
  if (account.token.expiry_timestamp < now + 300) {
    // 5 minutes buffer
    logger.info(`Token for ${account.email} near expiry, refreshing...`);
    try {
      const newTokenData = await GoogleAPIService.refreshAccessToken(account.token.refresh_token);

      // Update token in memory object
      account.token.access_token = newTokenData.access_token;
      account.token.expires_in = newTokenData.expires_in;
      account.token.expiry_timestamp = now + newTokenData.expires_in;

      // Save to DB
      await CloudAccountRepo.updateToken(account.id, account.token);
    } catch (e) {
      logger.error(`Failed to refresh token during time-check for ${account.email}`, e);
    }
  }

  try {
    const quota = await GoogleAPIService.fetchQuota(account.token.access_token);
    account.quota = quota;
    await CloudAccountRepo.updateQuota(account.id, quota);
    await CloudAccountRepo.updateLastUsed(account.id);
    account.last_used = Math.floor(Date.now() / 1000); // Sync memory object
    notifyTrayUpdate(account);
    return account;
  } catch (error: any) {
    if (error.message === 'UNAUTHORIZED') {
      logger.warn(`Got 401 Unauthorized for ${account.email}, forcing token refresh...`);
      try {
        // Force Refresh
        const newTokenData = await GoogleAPIService.refreshAccessToken(account.token.refresh_token);
        now = Math.floor(Date.now() / 1000);

        account.token.access_token = newTokenData.access_token;
        account.token.expires_in = newTokenData.expires_in;
        account.token.expiry_timestamp = now + newTokenData.expires_in;

        await CloudAccountRepo.updateToken(account.id, account.token);

        // Retry Quota
        const quota = await GoogleAPIService.fetchQuota(account.token.access_token);
        account.quota = quota;
        await CloudAccountRepo.updateQuota(account.id, quota);
        await CloudAccountRepo.updateLastUsed(account.id);
        account.last_used = Math.floor(Date.now() / 1000); // Sync memory object
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
      // Return existing account to avoid crash
      return account;
    }

    logger.error(`Failed to refresh quota for ${account.email}`, error);
    throw error;
  }
}

export async function switchCloudAccount(accountId: string): Promise<void> {
  try {
    const account = await CloudAccountRepo.getAccount(accountId);
    if (!account) {
      throw new Error(`Account not found: ${accountId}`);
    }

    logger.info(`Switching to cloud account: ${account.email} (${account.id})`);

    // 1. Ensure token is fresh before injecting
    const now = Math.floor(Date.now() / 1000);
    if (account.token.expiry_timestamp < now + 300) {
      logger.info(`Token for ${account.email} near expiry, refreshing before switch...`);
      try {
        const newTokenData = await GoogleAPIService.refreshAccessToken(account.token.refresh_token);
        account.token.access_token = newTokenData.access_token;
        account.token.expires_in = newTokenData.expires_in;
        account.token.expiry_timestamp = now + newTokenData.expires_in;
        await CloudAccountRepo.updateToken(account.id, account.token);
      } catch (e) {
        logger.warn('Failed to refresh token before switch, trying with existing token', e);
      }
    }

    // 2. Stop Antigravity Process
    await closeAntigravity();
    try {
      await _waitForProcessExit(10000); // Wait up to 10s for it to truly vanish
    } catch (e) {
      logger.warn('Process did not exit cleanly within timeout, but proceeding...', e);
    }

    // 3. Backup Database (New Logic)
    const dbPaths = getAntigravityDbPaths();
    // Find the valid DB path
    let dbPath: string | null = null;
    for (const p of dbPaths) {
      if (fs.existsSync(p)) {
        dbPath = p;
        break;
      }
    }

    if (dbPath) {
      try {
        const backupPath = `${dbPath}.backup`;
        fs.copyFileSync(dbPath, backupPath);
        logger.info(`Backed up database to ${backupPath}`);
      } catch (e) {
        logger.error('Failed to backup database', e);
      }
    }

    // 3. Inject Token
    // injectedCloudToken uses direct DB/FS access which is sync better-sqlite3.
    CloudAccountRepo.injectCloudToken(account);

    // 4. Update usage and active status
    CloudAccountRepo.updateLastUsed(account.id);
    CloudAccountRepo.setActive(account.id);

    // 5. Restart Process
    await startAntigravity();

    logger.info(`Successfully switched to cloud account: ${account.email}`);
    notifyTrayUpdate(account);
  } catch (err: any) {
    logger.error('Failed to switch cloud account', err);
    throw new Error(`Switch failed: ${err.message || 'Unknown error'}`);
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
  const url = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${CLIENT_ID}&redirect_uri=${REDIRECT_URI}&response_type=code&scope=${SCOPE}&access_type=offline&prompt=consent&include_granted_scopes=true`;

  logger.info(`Starting auth flow, opening URL: ${url}`);
  await shell.openExternal(url);
}
