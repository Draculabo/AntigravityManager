import { v4 as uuidv4 } from 'uuid';
import { CloudAccountRepo } from '../../ipc/database/cloudHandler';
import { GoogleAPIService } from '../../services/GoogleAPIService';
import { CloudAccount } from '../../types/cloudAccount';
import { logger } from '../../utils/logger';

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
        refresh_token: tokenResp.refresh_token || '', // Handle missing refresh token later (re-auth needed?)
        expires_in: tokenResp.expires_in,
        expiry_timestamp: now + tokenResp.expires_in,
        token_type: tokenResp.token_type,
        email: userInfo.email,
      },
      created_at: now,
      last_used: now,
    };

    // 4. Save to DB
    await CloudAccountRepo.addAccount(account);

    // 5. Initial Quota Check (Async, best effort)
    try {
      const quota = await GoogleAPIService.fetchQuota(account.token.access_token);
      account.quota = quota;
      await CloudAccountRepo.updateQuota(account.id, quota);
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
  // TODO: Move this logic to a shared TokenService later?
  const now = Math.floor(Date.now() / 1000);
  if (account.token.expiry_timestamp < now + 300) {
    // 5 minutes buffer
    logger.info(`Token for ${account.email} near expiry, refreshing...`);
    const newTokenData = await GoogleAPIService.refreshAccessToken(account.token.refresh_token);

    // Update token in memory object
    account.token.access_token = newTokenData.access_token;
    account.token.expires_in = newTokenData.expires_in;
    account.token.expiry_timestamp = now + newTokenData.expires_in;

    // Save to DB
    await CloudAccountRepo.updateToken(account.id, account.token);
  }

  try {
    const quota = await GoogleAPIService.fetchQuota(account.token.access_token);
    account.quota = quota;
    await CloudAccountRepo.updateQuota(account.id, quota);
    return account;
  } catch (error) {
    logger.error(`Failed to refresh quota for ${account.email}`, error);
    throw error;
  }
}

export async function switchCloudAccount(accountId: string): Promise<void> {
  const account = await CloudAccountRepo.getAccount(accountId);
  if (!account) {
    throw new Error(`Account not found: ${accountId}`);
  }

  logger.info(`Switching to cloud account: ${account.email} (${account.id})`);

  // 1. Ensure token is fresh before injecting
  const now = Math.floor(Date.now() / 1000);
  if (account.token.expiry_timestamp < now + 300) {
    logger.info(`Token for ${account.email} near expiry, refreshing before switch...`);
    const newTokenData = await GoogleAPIService.refreshAccessToken(account.token.refresh_token);
    account.token.access_token = newTokenData.access_token;
    account.token.expires_in = newTokenData.expires_in;
    account.token.expiry_timestamp = now + newTokenData.expires_in;
    await CloudAccountRepo.updateToken(account.id, account.token);
  }

  // 2. Stop Antigravity Process
  const { stopAntigravity, startAntigravity } = require('../../ipc/process/handler');
  await stopAntigravity(); // This waits for it to close

  // 3. Inject Token
  // injectCloudToken uses sync fs/sqlite logic internally, so it can remain sync OR be made async.
  // Currently checking cloudHandler.ts... injectCloudToken is NOT async in my previous update plan (I missed it or left it sync).
  // Checking cloudHandler.ts again... I didn't update injectCloudToken to async in the previous step because it wasn't in the grep/edit scope.
  // It uses direct DB/FS access which is sync better-sqlite3. So it is fine to remain sync if it doesn't use encryption.
  // Wait, does it use encryption? It READS from CloudAccount object which is already decrypted in memory.
  // It writes to Antigravity DB which is NOT encrypted by us (it's the IDE's db).
  // So injectCloudToken can remain sync.
  CloudAccountRepo.injectCloudToken(account.token);

  // 4. Update usage and active status
  CloudAccountRepo.updateLastUsed(account.id);
  CloudAccountRepo.setActive(account.id);

  // 5. Restart Process
  await startAntigravity();

  logger.info(`Successfully switched to cloud account: ${account.email}`);
}

export function getAutoSwitchEnabled(): boolean {
  return CloudAccountRepo.getSetting<boolean>('auto_switch_enabled', false);
}

export function setAutoSwitchEnabled(enabled: boolean): void {
  CloudAccountRepo.setSetting('auto_switch_enabled', enabled);
  // Trigger an immediate check if enabled?
  // Why not.
  if (enabled) {
    const { CloudMonitorService } = require('../../services/CloudMonitorService');
    CloudMonitorService.poll();
  }
}

export async function forcePollCloudMonitor(): Promise<void> {
  const { CloudMonitorService } = require('../../services/CloudMonitorService');
  await CloudMonitorService.poll();
}
