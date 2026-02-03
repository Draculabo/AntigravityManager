import { CloudAccountRepo } from '../ipc/database/cloudHandler';
import { GoogleAPIService } from './GoogleAPIService';
import { CloudAccount, CloudTokenData } from '../types/cloudAccount';
import { logger } from '../utils/logger';

export class CloudAccountService {
  private static refreshLocks = new Map<string, Promise<CloudAccount>>();

  /**
   * Refreshes the access token for a given account and updates it in the database.
   * Uses a lock to prevent concurrent refreshes for the same account.
   * @param account The cloud account to refresh
   * @returns The updated cloud account object
   */
  static async refreshAndSaveToken(account: CloudAccount): Promise<CloudAccount> {
    const lockKey = `token-${account.id}`;
    if (this.refreshLocks.has(lockKey)) {
      logger.info(`Token refresh already in progress for ${account.email}, waiting...`);
      return this.refreshLocks.get(lockKey)!;
    }

    const refreshPromise = (async () => {
      try {
        if (!account.token.refresh_token) {
          throw new Error(`Refresh token missing for ${account.email}`);
        }

        logger.info(`Refreshing token for ${account.email}`);
        const newTokenData = await GoogleAPIService.refreshAccessToken(account.token.refresh_token);
        const now = Math.floor(Date.now() / 1000);

        const updatedToken: CloudTokenData = {
          ...account.token,
          access_token: newTokenData.access_token,
          expires_in: newTokenData.expires_in,
          expiry_timestamp: now + newTokenData.expires_in,
        };

        // Update the memory object
        account.token = updatedToken;

        // Persist to database
        await CloudAccountRepo.updateToken(account.id, updatedToken);

        return account;
      } finally {
        this.refreshLocks.delete(lockKey);
      }
    })();

    this.refreshLocks.set(lockKey, refreshPromise);
    return refreshPromise;
  }

  /**
   * Refreshes the quota for a given account and updates it in the database.
   * Handles token refresh if unauthorized (401).
   * Uses a lock to prevent concurrent quota refreshes for the same account.
   * @param accountId The ID of the account to refresh
   * @returns The updated cloud account object
   */
  static async refreshQuota(accountId: string): Promise<CloudAccount> {
    const lockKey = `quota-${accountId}`;
    if (this.refreshLocks.has(lockKey)) {
      logger.info(`Quota refresh already in progress for account ${accountId}, waiting...`);
      return this.refreshLocks.get(lockKey)!;
    }

    const refreshPromise = (async () => {
      try {
        const account = await CloudAccountRepo.getAccount(accountId);
        if (!account) {
          throw new Error(`Account not found: ${accountId}`);
        }

        // 1. Pre-emptive check: Refresh if near expiry (5 mins buffer)
        const now = Math.floor(Date.now() / 1000);
        if (account.token.expiry_timestamp < now + 300) {
          await this.refreshAndSaveToken(account);
        }

        try {
          // 2. Fetch Quota
          const quota = await GoogleAPIService.fetchQuota(account.token.access_token);

          // 3. Update account and database
          account.quota = quota;
          await CloudAccountRepo.updateQuota(account.id, quota);
          await CloudAccountRepo.updateLastUsed(account.id);
          account.last_used = Math.floor(Date.now() / 1000);

          return account;
        } catch (error: any) {
          // 4. Force refresh on 401 Unauthorized
          if (error.message === 'UNAUTHORIZED') {
            logger.warn(`Unauthorized (401) for ${account.email}, forcing refresh and retry...`);
            await this.refreshAndSaveToken(account);

            // Retry fetch quota once
            const quota = await GoogleAPIService.fetchQuota(account.token.access_token);
            account.quota = quota;
            await CloudAccountRepo.updateQuota(account.id, quota);
            await CloudAccountRepo.updateLastUsed(account.id);
            account.last_used = Math.floor(Date.now() / 1000);

            return account;
          }

          throw error;
        }
      } finally {
        this.refreshLocks.delete(lockKey);
      }
    })();

    this.refreshLocks.set(lockKey, refreshPromise);
    return refreshPromise;
  }
}
