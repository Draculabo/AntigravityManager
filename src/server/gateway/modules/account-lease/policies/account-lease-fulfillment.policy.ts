import type { CloudAccount } from '@/modules/cloud-account/types';
import { googleUsageGrantHash } from '@/modules/cloud-account/incarnation';
import type {
  AccountLeaseHydrationPolicy,
  AccountLeaseRefreshControl,
} from './account-lease-hydration.policy';
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
  resolveFallbackProjectId: () => string;
  logger: AccountLeaseFulfillmentLogger;
}

interface FinalizeSelectedTokenRequest {
  accountId: string;
  tokenData: AccountLeaseTokenData;
  nowSeconds: number;
  control?: AccountLeaseRefreshControl;
}

export class AccountLeaseFulfillmentPolicy {
  constructor(private readonly options: AccountLeaseFulfillmentPolicyOptions) {}

  async finalizeSelectedToken(request: FinalizeSelectedTokenRequest): Promise<CloudAccount | null> {
    const { accountId, tokenData, nowSeconds } = request;

    try {
      const effectiveProjectId = await this.options.hydrationPolicy.hydrateSelectedToken({
        accountId,
        tokenData,
        nowSeconds,
        fallbackProjectId: this.options.resolveFallbackProjectId(),
        ...(request.control ? { control: request.control } : {}),
      });
      const persistedAccount = await this.options.accountStore.getAccount(accountId);
      if (!persistedAccount || !this.options.isStillEligible(accountId, tokenData)) {
        return null;
      }

      const timestamp = Date.now();
      const token = {
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
      };
      return {
        id: accountId,
        lifecycle_generation: tokenData.stored_context?.account.lifecycle_generation,
        google_usage_subject_hash: tokenData.stored_context?.account.google_usage_subject_hash,
        google_usage_grant_hash: googleUsageGrantHash(token) ?? undefined,
        provider: 'google',
        email: tokenData.email,
        device_profile: persistedAccount.device_profile,
        token,
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
