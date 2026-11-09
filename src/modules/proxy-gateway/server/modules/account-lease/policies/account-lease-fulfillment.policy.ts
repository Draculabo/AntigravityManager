import type { CloudAccount } from '@/modules/cloud-account/types';
import type { AccountLeaseHydrationPolicy } from './account-lease-hydration.policy';
import { AccountLeaseRefreshRejectedError } from './account-lease-hydration.policy';
import type { AccountLeaseTokenData } from '../interfaces/account-lease-token-types';
import type { AccountLeaseAccountStore } from '../interfaces/account-lease-adapters';

interface AccountLeaseFulfillmentLogger {
  error(message: string, error?: unknown): void;
}

interface AccountLeaseFulfillmentPolicyOptions {
  accountStore: AccountLeaseAccountStore;
  isStillEligible: (accountId: string, tokenData: AccountLeaseTokenData) => boolean;
  hydrationPolicy: AccountLeaseHydrationPolicy;
  bindSession: (sessionKey: string | undefined, accountId: string, expiresAt: number) => void;
  stickySessionTtlMs: number;
  resolveFallbackProjectId: () => string;
  logger: AccountLeaseFulfillmentLogger;
}

interface FinalizeSelectedTokenRequest {
  accountId: string;
  tokenData: AccountLeaseTokenData;
  nowSeconds: number;
  sessionKey?: string;
}

export class AccountLeaseFulfillmentPolicy {
  constructor(private readonly options: AccountLeaseFulfillmentPolicyOptions) {}

  async finalizeSelectedToken(request: FinalizeSelectedTokenRequest): Promise<CloudAccount | null> {
    const { accountId, tokenData, nowSeconds, sessionKey } = request;

    try {
      const effectiveProjectId = await this.options.hydrationPolicy.hydrateSelectedToken({
        accountId,
        tokenData,
        nowSeconds,
        fallbackProjectId: this.options.resolveFallbackProjectId(),
      });
      const persistedAccount = await this.options.accountStore.getAccount(accountId);
      if (!persistedAccount || !this.options.isStillEligible(accountId, tokenData)) {
        return null;
      }

      this.options.bindSession(sessionKey, accountId, Date.now() + this.options.stickySessionTtlMs);

      const timestamp = Date.now();
      return {
        id: accountId,
        provider: 'google',
        email: tokenData.email,
        device_profile: persistedAccount.device_profile,
        token: {
          access_token: tokenData.access_token,
          refresh_token: tokenData.refresh_token,
          id_token: tokenData.id_token,
          token_type: tokenData.token_type,
          expires_in: tokenData.expires_in,
          expiry_timestamp: tokenData.expiry_timestamp,
          project_id: effectiveProjectId,
          oauth_client_key: tokenData.oauth_client_key,
          session_id: tokenData.session_id,
          upstream_proxy_url: tokenData.upstream_proxy_url,
        },
        created_at: timestamp,
        last_used: timestamp,
      };
    } catch (error) {
      if (error instanceof AccountLeaseRefreshRejectedError) {
        throw error;
      }
      this.options.logger.error('Failed to finalize selected account token', error);
      throw error;
    }
  }
}
