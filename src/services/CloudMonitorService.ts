import { CloudAccountRepo } from '../ipc/database/cloudHandler';
import { GoogleAPIService } from './GoogleAPIService';
import { AutoSwitchService } from './AutoSwitchService';
import { logger } from '../utils/logger';

export class CloudMonitorService {
  private static intervalId: NodeJS.Timeout | null = null;
  private static POLL_INTERVAL = 1000 * 60 * 5; // 5 minutes

  static start() {
    if (this.intervalId) return;
    logger.info('Starting CloudMonitorService...');

    // Initial Poll
    this.poll().catch((e) => logger.error('Initial poll failed', e));

    this.intervalId = setInterval(() => {
      this.poll().catch((e) => logger.error('Scheduled poll failed', e));
    }, this.POLL_INTERVAL);
  }

  static stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      logger.info('Stopped CloudMonitorService');
    }
  }

  static async poll() {
    logger.info('CloudMonitor: Polling quotas...');
    const accounts = await CloudAccountRepo.getAccounts();
    const now = Math.floor(Date.now() / 1000);

    for (const account of accounts) {
      try {
        // 1. Check/Refresh Token if needed (give it a 10 min buffer here for safety)
        let accessToken = account.token.access_token;
        if (account.token.expiry_timestamp < now + 600) {
          logger.info(`Monitor: Refreshing token for ${account.email}`);
          const newToken = await GoogleAPIService.refreshAccessToken(account.token.refresh_token);
          account.token.access_token = newToken.access_token;
          account.token.expires_in = newToken.expires_in;
          account.token.expiry_timestamp = now + newToken.expires_in;
          await CloudAccountRepo.updateToken(account.id, account.token);
          accessToken = newToken.access_token;
        }

        // 2. Fetch Quota
        // We delay slightly between requests to act human/avoid spike
        await new Promise((r) => setTimeout(r, 1000));
        const quota = await GoogleAPIService.fetchQuota(accessToken);

        // 3. Update DB
        await CloudAccountRepo.updateQuota(account.id, quota);
      } catch (error) {
        logger.error(`Monitor: Failed to update ${account.email}`, error);
        // Could mark status as 'error' or 'rate_limited' if 429
      }
    }

    // 4. Check for Auto-Switch
    await AutoSwitchService.checkAndSwitchIfNeeded();
  }
}
