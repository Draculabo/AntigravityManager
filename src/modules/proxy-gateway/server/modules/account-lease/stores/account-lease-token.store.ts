import type { CloudAccount } from '@/modules/cloud-account/types';
import { isServiceDisabledReason } from '@/modules/cloud-account/utils/account-status';
import { isEqual } from 'lodash-es';
import type { AccountLeaseAccountStore } from '../interfaces/account-lease-adapters';
import { leaseStoredContext } from '../policies/account-lease-writeback';
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
  private loadGeneration = Symbol();

  constructor(private readonly options: AccountLeaseTokenCacheOptions) {}

  /** Even eviction from an empty cache invalidates snapshots already being read. */
  invalidateLoads(): void {
    this.loadGeneration = Symbol();
  }

  replaceAccountToken(account: CloudAccount): void {
    this.invalidateLoads();
    const tokens = this.options.getTokenCache();
    const previous = tokens.get(account.id);
    if (!previous) {
      return;
    }
    const replacement = this.mapAccountToTokenData(
      account,
      buildAccountLeaseQuotaSnapshot(account.quota),
    );
    replacement.session_id = account.token.session_id || previous.session_id;
    tokens.set(account.id, replacement);
  }

  async loadAccounts(beforeRead?: () => Promise<void>): Promise<number> {
    const prepareRead = this.prepareLoad();
    if (beforeRead) {
      await beforeRead();
    }
    try {
      return await this.replaceAccounts(prepareRead());
    } catch (error) {
      this.options.logger.error('Failed to load cloud accounts into token cache', error);
      return 0;
    }
  }

  async loadAccountsOrThrow(beforeRead?: () => Promise<void>): Promise<number> {
    const prepareRead = this.prepareLoad();
    try {
      if (beforeRead) {
        await beforeRead();
      }
      return await this.replaceAccounts(prepareRead());
    } catch (error) {
      this.options.logger.error('Failed to load cloud accounts into token cache', error);
      throw error;
    }
  }

  private mapAccountToTokenData(
    account: CloudAccount,
    extractedState: AccountLeaseQuotaSnapshot,
  ): AccountLeaseTokenData {
    const quota = account.quota;

    return {
      stored_context: leaseStoredContext(account),
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
      device_profile: account.device_profile,
      proxy_priority: account.proxy_priority ?? 50,
      proxy_enabled: account.proxy_enabled !== false,
      validation_blocked_until_ms: account.health?.validation?.next_probe_at_ms,
      service_disabled:
        account.health?.service_disabled !== undefined ||
        isServiceDisabledReason(account.status_reason ?? ''),
      oauth_health: account.health?.oauth,
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

  private prepareLoad(): () => () => void {
    const generation = (this.loadGeneration = Symbol());
    const tokenCache = this.options.getTokenCache();
    // Entry/scalar updates during the store read must not be overwritten by its older snapshot.
    // Nested quota/health values have their existing immutable replacement owners.
    const before = Array.from(tokenCache, ([id, entry]) => ({
      id,
      entry,
      state: { ...entry },
      storedAccount: entry.stored_context?.account,
    }));
    const assertCurrent = () => {
      if (
        generation !== this.loadGeneration ||
        tokenCache !== this.options.getTokenCache() ||
        tokenCache.size !== before.length ||
        before.some(
          ({ id, entry, state }) => tokenCache.get(id) !== entry || !isEqual(entry, state),
        )
      ) {
        throw new AccountLeaseLoadSupersededError();
      }
    };
    return () => {
      assertCurrent();
      // Reconciliation may have advanced the persisted snapshot before the read starts.
      for (const item of before) {
        item.storedAccount = item.entry.stored_context?.account;
      }
      return () => {
        assertCurrent();
        if (
          before.some(({ entry, storedAccount }) => entry.stored_context?.account !== storedAccount)
        ) {
          throw new AccountLeaseLoadSupersededError();
        }
      };
    };
  }

  private async replaceAccounts(assertLoadCurrent: () => void): Promise<number> {
    const tokenCache = this.options.getTokenCache();
    const accounts = await this.options.accountStore.getAccounts();
    assertLoadCurrent();

    const prepared = accounts.flatMap((account) => {
      if (account.health?.oauth?.refresh_blocked === true) {
        return [];
      }
      const snapshot = buildAccountLeaseQuotaSnapshot(account.quota);
      return [{ id: account.id, token: this.mapAccountToTokenData(account, snapshot), snapshot }];
    });

    for (const { snapshot } of prepared) {
      this.options.applyQuotaSnapshot(snapshot);
    }

    tokenCache.clear();
    for (const { id, token } of prepared) {
      tokenCache.set(id, token);
    }

    const count = tokenCache.size;
    this.options.logger.log(`Account lease loaded ${count} cloud accounts into cache`);
    return count;
  }
}

export class AccountLeaseLoadSupersededError extends Error {
  constructor() {
    super('Account cache changed while a stored snapshot was loading');
    this.name = 'AccountLeaseLoadSupersededError';
  }
}
