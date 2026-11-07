import { CloudAccountRepo } from '@/modules/cloud-account/persistence/cloudHandler';
import { CloudAccount, CloudQuotaData } from '@/modules/cloud-account/types';
import {
  GoogleAPIService,
  type TokenResponse,
} from '@/modules/cloud-account/services/GoogleAPIService';
import { CloudAccountRefreshService } from '@/modules/cloud-account/services/CloudAccountRefreshService';
import { CloudAccountHealthService } from '@/modules/cloud-account/services/CloudAccountHealthService';

export const ACCOUNT_LEASE_ACCOUNT_STORE = Symbol('ACCOUNT_LEASE_ACCOUNT_STORE');
export const ACCOUNT_LEASE_UPSTREAM = Symbol('ACCOUNT_LEASE_UPSTREAM');

export interface AccountLeaseAccountStore {
  getAccounts(): Promise<CloudAccount[]>;
  getAccount(accountId: string): Promise<CloudAccount | undefined>;
  updateToken(accountId: string, token: CloudAccount['token']): Promise<void>;
  updateQuota(accountId: string, quota: CloudQuotaData): Promise<void>;
  mutateHealth(
    accountId: string,
    mutation: (health: CloudAccount['health']) => CloudAccount['health'],
  ): Promise<CloudAccount['health']>;
  setAccountStatus?(
    accountId: string,
    status: CloudAccount['status'],
    reason?: string | null,
  ): Promise<void>;
}

export interface AccountLeaseUpstream {
  fetchQuota(accessToken: string, proxyUrl?: string): Promise<CloudQuotaData>;
  refreshAccessToken(
    accountId: string,
    refreshToken: string,
    proxyUrl?: string,
    oauthClientKey?: string,
    health?: CloudAccount['health'],
  ): Promise<TokenResponse>;
  fetchProjectId(accessToken: string, proxyUrl?: string): Promise<string | null>;
  normalizeRefreshedOAuthClientKey(
    currentToken: { oauth_client_key?: string; project_id?: string },
    refreshedClientKey?: string,
  ): string | undefined;
}

export const cloudAccountStoreAdapter: AccountLeaseAccountStore = {
  getAccounts: () => CloudAccountRepo.getAccounts(),
  getAccount: (accountId) => CloudAccountRepo.getAccount(accountId),
  updateToken: (accountId, token) => CloudAccountRepo.updateToken(accountId, token),
  updateQuota: (accountId, quota) => CloudAccountRepo.updateQuota(accountId, quota),
  mutateHealth: (accountId, mutation) =>
    CloudAccountHealthService.mutateHealth(accountId, mutation),
  setAccountStatus: (accountId, status, reason) =>
    CloudAccountRepo.setAccountStatus(accountId, status, reason),
};

export const googleAccountLeaseUpstreamAdapter: AccountLeaseUpstream = {
  fetchQuota: (accessToken, proxyUrl) => GoogleAPIService.fetchQuota(accessToken, proxyUrl),
  refreshAccessToken: (accountId, refreshToken, proxyUrl, oauthClientKey, health) =>
    CloudAccountRefreshService.refreshAccessToken({
      accountId,
      refreshToken,
      proxyUrl,
      oauthClientKey,
      health,
    }),
  fetchProjectId: (accessToken, proxyUrl) =>
    proxyUrl
      ? GoogleAPIService.fetchProjectId(accessToken, proxyUrl)
      : GoogleAPIService.fetchProjectId(accessToken),
  normalizeRefreshedOAuthClientKey: (currentToken, refreshedClientKey) =>
    GoogleAPIService.normalizeRefreshedOAuthClientKey(currentToken, refreshedClientKey),
};
