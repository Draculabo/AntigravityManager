import { CloudAccountRepo } from '@/modules/cloud-account/persistence/cloudHandler';
import { CloudAccount, CloudQuotaData } from '@/modules/cloud-account/types';
import {
  GoogleAPIService,
  type TokenResponse,
} from '@/modules/cloud-account/services/GoogleAPIService';
import { CloudAccountRefreshService } from '@/modules/cloud-account/services/CloudAccountRefreshService';
import { CloudAccountHealthService } from '@/modules/cloud-account/services/CloudAccountHealthService';
import type { CloudAccountWriteGuard } from '@/modules/cloud-account/persistence/cloudHandler';

export const ACCOUNT_LEASE_ACCOUNT_STORE = Symbol('ACCOUNT_LEASE_ACCOUNT_STORE');
export const ACCOUNT_LEASE_UPSTREAM = Symbol('ACCOUNT_LEASE_UPSTREAM');

export interface AccountLeaseAccountStore {
  assertCurrentAccount?(accountId: string, guard: CloudAccountWriteGuard): void;
  getAccounts(): Promise<CloudAccount[]>;
  getAccount(accountId: string): Promise<CloudAccount | undefined>;
  updateToken(
    accountId: string,
    token: CloudAccount['token'],
    guard?: CloudAccountWriteGuard,
  ): Promise<void>;
  compareAndUpdateToken(
    accountId: string,
    expected: CloudAccount['token'],
    token: CloudAccount['token'],
    guard?: CloudAccountWriteGuard,
  ): Promise<boolean>;
  updateQuota(
    accountId: string,
    quota: CloudQuotaData,
    guard?: CloudAccountWriteGuard,
  ): Promise<void>;
  mutateHealth(
    accountId: string,
    mutation: (health: CloudAccount['health']) => CloudAccount['health'],
    guard?: CloudAccountWriteGuard,
  ): Promise<CloudAccount['health']>;
  setAccountStatus?(
    accountId: string,
    status: CloudAccount['status'],
    reason?: string | null,
  ): Promise<void>;
}

export interface AccountLeaseUpstream {
  fetchQuota(accessToken: string, proxyUrl?: string, signal?: AbortSignal): Promise<CloudQuotaData>;
  refreshAccessToken(
    accountId: string,
    refreshToken: string,
    proxyUrl?: string,
    oauthClientKey?: string,
    health?: CloudAccount['health'],
    execution?: { signal: AbortSignal; assertCurrent: () => void },
  ): Promise<TokenResponse>;
  fetchProjectId(
    accessToken: string,
    proxyUrl?: string,
    signal?: AbortSignal,
  ): Promise<string | null>;
  normalizeRefreshedOAuthClientKey(
    currentToken: { oauth_client_key?: string; project_id?: string },
    refreshedClientKey?: string,
  ): string | undefined;
}

export const cloudAccountStoreAdapter: AccountLeaseAccountStore = {
  assertCurrentAccount: (accountId, guard) =>
    CloudAccountRepo.assertCurrentAccount(accountId, guard),
  getAccounts: () => CloudAccountRepo.getAccounts(),
  getAccount: (accountId) => CloudAccountRepo.getAccount(accountId),
  updateToken: (accountId, token, guard) => CloudAccountRepo.updateToken(accountId, token, guard),
  compareAndUpdateToken: (accountId, expected, token, guard) =>
    guard
      ? CloudAccountRepo.compareAndUpdateToken(accountId, expected, token, guard, true)
      : CloudAccountRepo.compareAndUpdateToken(accountId, expected, token),
  updateQuota: (accountId, quota, guard) => CloudAccountRepo.updateQuota(accountId, quota, guard),
  mutateHealth: (accountId, mutation, guard) =>
    CloudAccountHealthService.mutateHealth(
      accountId,
      mutation,
      guard ? { assertAccount: guard } : undefined,
    ),
  setAccountStatus: (accountId, status, reason) =>
    CloudAccountRepo.setAccountStatus(accountId, status, reason),
};

export const googleAccountLeaseUpstreamAdapter: AccountLeaseUpstream = {
  fetchQuota: (accessToken, proxyUrl, signal) =>
    signal
      ? GoogleAPIService.fetchQuota(accessToken, proxyUrl, signal)
      : GoogleAPIService.fetchQuota(accessToken, proxyUrl),
  refreshAccessToken: (accountId, refreshToken, proxyUrl, oauthClientKey, health, execution) =>
    CloudAccountRefreshService.refreshAccessToken({
      accountId,
      refreshToken,
      proxyUrl,
      oauthClientKey,
      health,
      ...execution,
    }),
  fetchProjectId: (accessToken, proxyUrl, signal) =>
    signal
      ? GoogleAPIService.fetchProjectId(accessToken, proxyUrl, signal)
      : proxyUrl
        ? GoogleAPIService.fetchProjectId(accessToken, proxyUrl)
        : GoogleAPIService.fetchProjectId(accessToken),
  normalizeRefreshedOAuthClientKey: (currentToken, refreshedClientKey) =>
    GoogleAPIService.normalizeRefreshedOAuthClientKey(currentToken, refreshedClientKey),
};
