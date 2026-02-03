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

import { CloudAccountService } from '../../services/CloudAccountService';
import { CloudMonitorService } from '../../services/CloudMonitorService';

// Fallback constants if service constants are not available or for direct usage
// CLIENT_ID, REDIRECT_URI, and SCOPE moved to GoogleAPIService

// Helper to update tray
async function notifyTrayUpdate(account: CloudAccount) {
  try {
    // Fetch language setting. Default to 'en' if not set.
    const lang = await CloudAccountRepo.getSettingAsync<string>('language', 'en');
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
  try {
    const account = await CloudAccountService.refreshQuota(accountId);
    notifyTrayUpdate(account);
    return account;
  } catch (error: any) {
    if (error.message === 'FORBIDDEN') {
      const account = await CloudAccountRepo.getAccount(accountId);
      if (account) {
        logger.warn(`Got 403 Forbidden for ${account.email}. Account may be rate limited.`);
        account.status = 'rate_limited';
        throw new Error(`Quota check failed: Account ${account.email} is rate limited (403 Forbidden). Please try again later.`);
      }
    }
    logger.error(`Failed to refresh quota for account ${accountId}`, error);
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
      await CloudAccountService.refreshAndSaveToken(account);
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

export async function getAutoSwitchEnabled(): Promise<boolean> {
  return CloudAccountRepo.getSettingAsync<boolean>('auto_switch_enabled', false);
}

export async function setAutoSwitchEnabled(enabled: boolean): Promise<void> {
  CloudAccountRepo.setSetting('auto_switch_enabled', enabled);
  // Trigger an immediate check if enabled
  if (enabled) {
    CloudMonitorService.poll().catch((err: any) =>
      logger.error('Failed to poll after enabling auto-switch', err),
    );
  }
}

export async function forcePollCloudMonitor(): Promise<void> {
  await CloudMonitorService.poll();
}

export async function startAuthFlow(): Promise<void> {
  const url = GoogleAPIService.getAuthUrl();

  logger.info(`Starting auth flow, opening URL: ${url}`);
  await shell.openExternal(url);
}
