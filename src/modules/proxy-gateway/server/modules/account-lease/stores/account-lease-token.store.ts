import type { CloudAccount } from '@/modules/cloud-account/types';
import type { AccountLeaseAccountStore } from '../interfaces/account-lease-adapters';
import {
  buildAccountLeaseQuotaSnapshot,
  type AccountLeaseQuotaSnapshot,
} from '../policies/account-lease-quota.policy';
import {
  type AccountLeaseTokenData,
  normalizeClientKey,
} from '../interfaces/account-lease-token-types';

interface AccountLeaseTokenCacheLogger {
  error(message: string, error?: unknown): void;
  log(message: string): void;
}

interface AccountLeaseTokenCacheOptions {
  accountStore: AccountLeaseAccountStore;
  getTokenCache: () => Map<string, AccountLeaseTokenData>;
  applyQuotaSnapshot: (snapshot: AccountLeaseQuotaSnapshot) => void;
  logger: AccountLeaseTokenCacheLogger;
}

export class AccountLeaseTokenCache {
  constructor(private readonly options: AccountLeaseTokenCacheOptions) {}

  async loadAccounts(): Promise<number> {
    try {
      return await this.replaceAccounts();
    } catch (error) {
      this.options.logger.error('Failed to load cloud accounts into token cache', error);
      return 0;
    }
  }

  async loadAccountsOrThrow(): Promise<number> {
    try {
      return await this.replaceAccounts();
    } catch (error) {
      this.options.logger.error('Failed to load cloud accounts into token cache', error);
      throw error;
    }
  }

  mapAccountToTokenData(account: CloudAccount): AccountLeaseTokenData | null {
    if (!account.token) {
      return null;
    }

    const quota = account.quota;
    const extractedState = buildAccountLeaseQuotaSnapshot(quota);
    this.options.applyQuotaSnapshot(extractedState);

    return {
      account_id: account.id,
      email: account.email,
      access_token: account.token.access_token,
      refresh_token: account.token.refresh_token,
      id_token: account.token.id_token,
      oauth_client_key: normalizeClientKey(account.token.oauth_client_key),
      token_type: account.token.token_type || 'Bearer',
      expires_in: account.token.expires_in,
      expiry_timestamp: account.token.expiry_timestamp,
      project_id: account.token.project_id || undefined,
      session_id: account.token.session_id || this.generateSessionId(),
      upstream_proxy_url: account.token.upstream_proxy_url || account.proxy_url || undefined,
      quota,
      model_quotas: extractedState.modelQuotas,
      model_limits: extractedState.modelLimits,
      model_reset_times: extractedState.modelResetTimes,
      model_forwarding_rules: extractedState.modelForwardingRules,
    };
  }

  private generateSessionId(): string {
    const min = 1_000_000_000_000_000_000n;
    const max = 9_000_000_000_000_000_000n;
    const range = max - min;
    const rand = BigInt(Math.floor(Math.random() * Number(range)));
    return (-(min + rand)).toString();
  }

  private async replaceAccounts(): Promise<number> {
    const accounts = await this.options.accountStore.getAccounts();
    let count = 0;
    const tokenCache = this.options.getTokenCache();

    tokenCache.clear();

    for (const account of accounts) {
      const tokenData = this.mapAccountToTokenData(account);
      if (tokenData) {
        tokenCache.set(account.id, tokenData);
        count++;
      }
    }

    this.options.logger.log(`Account lease loaded ${count} cloud accounts into cache`);
    return count;
  }
}
