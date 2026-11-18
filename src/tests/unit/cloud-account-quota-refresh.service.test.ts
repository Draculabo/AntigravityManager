import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CloudAccountRepo } from '@/modules/cloud-account/persistence/cloudHandler';
import type { CloudAccount } from '@/modules/cloud-account/types';
import {
  GoogleAPIService,
  OAuthTokenRefreshError,
} from '@/modules/cloud-account/services/GoogleAPIService';
import {
  CLOUD_ACCOUNT_REAUTH_REQUIRED_REASON,
  CloudAccountRefreshBlockedError,
  CloudAccountRefreshService,
} from '@/modules/cloud-account/services/CloudAccountRefreshService';
import { refreshAccountQuotaCore } from '@/modules/cloud-account/services/cloud-account-quota-refresh.service';
import { clearValidationHealthAfterSuccessfulProbe } from '@/modules/cloud-account/services/CloudAccountHealthService';
import { proxyModelAvailabilityStore } from '@/server/gateway/shared/services/model-availability.service';
import { AccountLeaseService } from '@/server/gateway/modules/account-lease/account-lease.service';
import { CloudAccountHealthSchema } from '@/modules/cloud-account/types';
import { CloudAccountHealthService } from '@/modules/cloud-account/services/CloudAccountHealthService';

const leaseBridge = vi.hoisted(() => ({ evict: vi.fn(), quarantine: vi.fn() }));

vi.mock('@/modules/cloud-account/services/CloudAccountHealthService', () => ({
  clearValidationHealthAfterSuccessfulProbe: vi.fn(async () => {}),
  CloudAccountHealthService: { mutateHealth: vi.fn(async (_id, update) => update(undefined)) },
  evictAccountFromActiveLeaseCache: vi.fn(async (id) => leaseBridge.evict(id)),
  quarantineAccountInActiveLeaseCache: vi.fn(async (id) => leaseBridge.quarantine(id)),
}));
vi.mock(
  '@/server/gateway/shared/services/model-availability.service',
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import('@/server/gateway/shared/services/model-availability.service')
      >();
    return { ...actual, proxyModelAvailabilityStore: new actual.ModelAvailabilityService() };
  },
);
vi.mock('@/shared/logging/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

function account(expiryTimestamp = Math.floor(Date.now() / 1000) + 3600): CloudAccount {
  return {
    id: 'quota-account',
    provider: 'google',
    email: 'quota@example.com',
    token: {
      access_token: 'old-access',
      refresh_token: 'old-refresh',
      expires_in: 3600,
      expiry_timestamp: expiryTimestamp,
      token_type: 'Bearer',
      project_id: 'quota-project',
    },
    quota: {
      models: { gemini: { percentage: 20, resetTime: 'later' } },
      ai_credits: { credits: 4, expiryDate: 'later' },
    },
    created_at: 1,
    last_used: 1,
    status: 'rate_limited',
    status_reason: 'old error',
  };
}

describe('Node-safe cloud account quota refresh', () => {
  afterEach(() => {
    proxyModelAvailabilityStore.clearAccount('quota-account');
  });
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    vi.spyOn(CloudAccountRepo, 'updateToken').mockResolvedValue();
    vi.spyOn(CloudAccountRepo, 'compareAndUpdateToken').mockResolvedValue(true);
    vi.spyOn(CloudAccountRepo, 'updateQuota').mockResolvedValue();
    vi.spyOn(CloudAccountRepo, 'updateLastUsed').mockResolvedValue();
    vi.spyOn(CloudAccountRepo, 'setAccountStatus').mockResolvedValue();
    vi.spyOn(GoogleAPIService, 'fetchAICredits').mockResolvedValue(null);
  });

  it('persists quota, retains cached credits, clears health and invokes only the primary hook', async () => {
    const stored = account();
    vi.spyOn(CloudAccountRepo, 'getAccount').mockResolvedValue(stored);
    vi.spyOn(GoogleAPIService, 'fetchQuota').mockResolvedValue({
      models: { gemini: { percentage: 90, resetTime: 'soon' } },
    });
    const onPrimarySuccess = vi.fn();
    const onRetrySuccess = vi.fn();

    proxyModelAvailabilityStore.mark(stored.id, 'gemini-3-pro-image', 'model_forbidden');
    const result = await refreshAccountQuotaCore(stored.id, { onPrimarySuccess, onRetrySuccess });

    expect(result).toBe(stored);
    expect(result.quota).toEqual({
      models: { gemini: { percentage: 90, resetTime: 'soon' } },
      ai_credits: { credits: 4, expiryDate: 'later' },
    });
    expect(CloudAccountRepo.updateQuota).toHaveBeenCalledWith(
      stored.id,
      result.quota,
      expect.any(Function),
    );
    expect(CloudAccountRepo.updateLastUsed).toHaveBeenCalledWith(stored.id, expect.any(Function));
    expect(CloudAccountRepo.setAccountStatus).toHaveBeenCalledWith(
      stored.id,
      'active',
      null,
      expect.any(Function),
    );
    expect(clearValidationHealthAfterSuccessfulProbe).toHaveBeenCalledWith(
      stored,
      expect.any(Function),
    );
    expect(proxyModelAvailabilityStore.isCapabilityBlocked(stored.id, 'gemini-3-pro-image')).toBe(
      true,
    );
    expect(onPrimarySuccess).toHaveBeenCalledOnce();
    expect(onRetrySuccess).not.toHaveBeenCalled();
  });

  it('retries 401 with a refreshed token and invokes only the retry hook', async () => {
    const stored = account();
    vi.spyOn(CloudAccountRepo, 'getAccount').mockResolvedValue(stored);
    vi.spyOn(GoogleAPIService, 'fetchQuota')
      .mockRejectedValueOnce(new Error('UNAUTHORIZED'))
      .mockResolvedValueOnce({ models: { gemini: { percentage: 70, resetTime: 'soon' } } });
    vi.spyOn(CloudAccountRefreshService, 'refreshAccessToken').mockResolvedValue({
      access_token: 'new-access',
      refresh_token: 'new-refresh',
      expires_in: 3600,
      token_type: 'Bearer',
    });
    const onPrimarySuccess = vi.fn();
    const onRetrySuccess = vi.fn();

    const result = await refreshAccountQuotaCore(stored.id, { onPrimarySuccess, onRetrySuccess });

    expect(GoogleAPIService.fetchQuota).toHaveBeenNthCalledWith(2, 'new-access', undefined);
    expect(CloudAccountRepo.compareAndUpdateToken).toHaveBeenCalledWith(
      stored.id,
      expect.objectContaining({ refresh_token: 'old-refresh' }),
      result.token,
      expect.any(Function),
      true,
    );
    expect(result.token.refresh_token).toBe('new-refresh');
    expect(result.quota?.ai_credits).toEqual({ credits: 4, expiryDate: 'later' });
    expect(onPrimarySuccess).not.toHaveBeenCalled();
    expect(onRetrySuccess).toHaveBeenCalledOnce();
  });

  it('does not use a refreshed token when the account changed during refresh', async () => {
    const stored = account(1);
    vi.spyOn(CloudAccountRepo, 'getAccount').mockResolvedValue(stored);
    vi.spyOn(CloudAccountRefreshService, 'refreshAccessToken').mockResolvedValue({
      access_token: 'new-access',
      refresh_token: 'new-refresh',
      expires_in: 3600,
      token_type: 'Bearer',
    });
    vi.mocked(CloudAccountRepo.compareAndUpdateToken).mockResolvedValue(false);
    const fetchQuota = vi.spyOn(GoogleAPIService, 'fetchQuota');
    await expect(refreshAccountQuotaCore(stored.id)).rejects.toThrow(
      'Account quota-account changed during OAuth refresh',
    );
    expect(stored.token.refresh_token).toBe('old-refresh');
    expect(fetchQuota).not.toHaveBeenCalled();
    expect(CloudAccountRepo.setAccountStatus).not.toHaveBeenCalled();
  });

  it('does not mark a replacement account expired when forced refresh conflicts', async () => {
    const stored = account();
    vi.spyOn(CloudAccountRepo, 'getAccount').mockResolvedValue(stored);
    vi.spyOn(GoogleAPIService, 'fetchQuota').mockRejectedValueOnce(new Error('UNAUTHORIZED'));
    vi.spyOn(CloudAccountRefreshService, 'refreshAccessToken').mockResolvedValue({
      access_token: 'new-access',
      refresh_token: 'new-refresh',
      expires_in: 3600,
      token_type: 'Bearer',
    });
    vi.mocked(CloudAccountRepo.compareAndUpdateToken).mockResolvedValue(false);
    await expect(refreshAccountQuotaCore(stored.id)).rejects.toThrow(
      'Account quota-account changed during OAuth refresh',
    );
    expect(CloudAccountRepo.setAccountStatus).not.toHaveBeenCalled();
    expect(GoogleAPIService.fetchQuota).toHaveBeenCalledOnce();
  });

  it('shares one in-flight quota refresh for concurrent callers of the same account', async () => {
    const stored = account();
    vi.spyOn(CloudAccountRepo, 'getAccount').mockResolvedValue(stored);
    let releaseQuota!: () => void;
    const quotaReady = new Promise<void>((resolve) => {
      releaseQuota = resolve;
    });
    const fetchQuota = vi.spyOn(GoogleAPIService, 'fetchQuota').mockImplementation(async () => {
      await quotaReady;
      return { models: { gemini: { percentage: 80, resetTime: 'soon' } } };
    });
    const firstHook = vi.fn();
    const secondHook = vi.fn();

    const first = refreshAccountQuotaCore(stored.id, { onPrimarySuccess: firstHook });
    const second = refreshAccountQuotaCore(stored.id, { onPrimarySuccess: secondHook });

    await Promise.resolve();
    expect(fetchQuota).toHaveBeenCalledOnce();
    releaseQuota();

    await expect(Promise.all([first, second])).resolves.toEqual([stored, stored]);
    expect(firstHook).toHaveBeenCalledOnce();
    expect(secondHook).not.toHaveBeenCalled();
  });

  it('preserves cached quota and marks a rate limit without success hooks', async () => {
    const stored = account();
    const cachedQuota = stored.quota;
    vi.spyOn(CloudAccountRepo, 'getAccount').mockResolvedValue(stored);
    vi.spyOn(GoogleAPIService, 'fetchQuota').mockRejectedValue(new Error('RESOURCE_EXHAUSTED'));
    const onPrimarySuccess = vi.fn();
    const onRetrySuccess = vi.fn();

    const result = await refreshAccountQuotaCore(stored.id, { onPrimarySuccess, onRetrySuccess });

    expect(result.quota).toBe(cachedQuota);
    expect(result.status).toBe('rate_limited');
    expect(CloudAccountRepo.setAccountStatus).toHaveBeenCalledWith(
      stored.id,
      'rate_limited',
      'RESOURCE_EXHAUSTED',
      expect.any(Function),
    );
    expect(CloudAccountRepo.updateQuota).not.toHaveBeenCalled();
    expect(onPrimarySuccess).not.toHaveBeenCalled();
    expect(onRetrySuccess).not.toHaveBeenCalled();
  });

  it('propagates a rate limit when no cached models are available', async () => {
    const stored = account();
    stored.quota = { models: {} };
    vi.spyOn(CloudAccountRepo, 'getAccount').mockResolvedValue(stored);
    const error = new Error('RESOURCE_EXHAUSTED');
    vi.spyOn(GoogleAPIService, 'fetchQuota').mockRejectedValue(error);

    await expect(refreshAccountQuotaCore(stored.id)).rejects.toBe(error);
    expect(stored.status).toBe('rate_limited');
    expect(CloudAccountRepo.updateQuota).not.toHaveBeenCalled();
  });

  it('uses cached quota if the 401 retry becomes rate limited', async () => {
    const stored = account();
    const cachedQuota = stored.quota;
    vi.spyOn(CloudAccountRepo, 'getAccount').mockResolvedValue(stored);
    vi.spyOn(GoogleAPIService, 'fetchQuota')
      .mockRejectedValueOnce(new Error('UNAUTHORIZED'))
      .mockRejectedValueOnce(new Error('RESOURCE_EXHAUSTED'));
    vi.spyOn(CloudAccountRefreshService, 'refreshAccessToken').mockResolvedValue({
      access_token: 'new-access',
      refresh_token: 'new-refresh',
      expires_in: 3600,
      token_type: 'Bearer',
    });
    const onPrimarySuccess = vi.fn();
    const onRetrySuccess = vi.fn();

    const result = await refreshAccountQuotaCore(stored.id, { onPrimarySuccess, onRetrySuccess });

    expect(result.quota).toBe(cachedQuota);
    expect(result.status).toBe('rate_limited');
    expect(CloudAccountRepo.compareAndUpdateToken).toHaveBeenCalledOnce();
    expect(CloudAccountRepo.updateQuota).not.toHaveBeenCalled();
    expect(onPrimarySuccess).not.toHaveBeenCalled();
    expect(onRetrySuccess).not.toHaveBeenCalled();
  });

  it('returns 403 with persisted account status and does not call success hooks', async () => {
    const stored = account();
    vi.spyOn(CloudAccountRepo, 'getAccount').mockResolvedValue(stored);
    vi.spyOn(GoogleAPIService, 'fetchQuota').mockRejectedValue(new Error('FORBIDDEN'));
    const onPrimarySuccess = vi.fn();

    const result = await refreshAccountQuotaCore(stored.id, { onPrimarySuccess });

    expect(result).toBe(stored);
    expect(CloudAccountRepo.updateQuota).not.toHaveBeenCalled();
    expect(onPrimarySuccess).not.toHaveBeenCalled();
  });

  it('evicts a loaded lease after background quota detects a ToS violation', async () => {
    const stored = account();
    const lease = new AccountLeaseService(
      {
        getAccounts: vi.fn(async () => [structuredClone(stored)]),
        getAccount: vi.fn(async () => structuredClone(stored)),
        updateToken: vi.fn(),
        compareAndUpdateToken: vi.fn().mockResolvedValue(true),
        updateQuota: vi.fn(),
        mutateHealth: vi.fn(),
      },
      {
        fetchQuota: vi.fn(),
        refreshAccessToken: vi.fn(),
        fetchProjectId: vi.fn(),
        normalizeRefreshedOAuthClientKey: vi.fn(),
      },
    );
    await lease.loadAccounts();
    expect((await lease.getNextToken({ targetAccountId: stored.id }))?.id).toBe(stored.id);
    leaseBridge.evict.mockImplementation((id) => lease.evictAccount(id));
    vi.spyOn(CloudAccountRepo, 'getAccount').mockResolvedValue(stored);
    vi.spyOn(GoogleAPIService, 'fetchQuota').mockRejectedValue(
      new Error('FORBIDDEN: TOS_VIOLATION'),
    );
    await refreshAccountQuotaCore(stored.id);
    expect(leaseBridge.evict).toHaveBeenCalledWith(stored.id);
    expect(await lease.getNextToken({ targetAccountId: stored.id })).toBeNull();
  });

  it('quarantines a loaded lease when ToS status persistence fails', async () => {
    const stored = account();
    const lease = new AccountLeaseService(
      {
        getAccounts: vi.fn(async () => [structuredClone(stored)]),
        getAccount: vi.fn(async () => structuredClone(stored)),
        updateToken: vi.fn(),
        compareAndUpdateToken: vi.fn().mockResolvedValue(true),
        updateQuota: vi.fn(),
        mutateHealth: vi.fn(),
      },
      {
        fetchQuota: vi.fn(),
        refreshAccessToken: vi.fn(),
        fetchProjectId: vi.fn(),
        normalizeRefreshedOAuthClientKey: vi.fn(),
      },
    );
    await lease.loadAccounts();
    leaseBridge.quarantine.mockImplementation((id) => lease.quarantineAccountInMemory(id));
    vi.spyOn(CloudAccountRepo, 'getAccount').mockResolvedValue(stored);
    vi.mocked(CloudAccountRepo.setAccountStatus).mockRejectedValueOnce(
      new Error('status write failed'),
    );
    vi.spyOn(GoogleAPIService, 'fetchQuota').mockRejectedValue(
      new Error('FORBIDDEN: TOS_VIOLATION'),
    );
    await expect(refreshAccountQuotaCore(stored.id)).rejects.toThrow('status write failed');
    expect(await lease.getNextToken({ targetAccountId: stored.id })).toBeNull();
  });

  it('persists a bounded provider message after a long ToS response', async () => {
    const stored = account();
    vi.spyOn(CloudAccountRepo, 'getAccount').mockResolvedValue(stored);
    vi.mocked(CloudAccountHealthService.mutateHealth).mockImplementationOnce(async (_id, update) =>
      CloudAccountHealthSchema.parse(update(undefined)),
    );
    vi.spyOn(GoogleAPIService, 'fetchQuota').mockRejectedValue(
      new Error(`FORBIDDEN: TOS_VIOLATION ${'x'.repeat(2000)}`),
    );
    await refreshAccountQuotaCore(stored.id);
    expect(stored.health?.service_disabled?.message?.length).toBeLessThanOrEqual(1000);
  });

  it('propagates the first invalid_grant without marking the account expired', async () => {
    const stored = account(1);
    vi.spyOn(CloudAccountRepo, 'getAccount').mockResolvedValue(stored);
    const error = new OAuthTokenRefreshError('invalid_grant', 400, 'default', 'expired');
    vi.spyOn(CloudAccountRefreshService, 'refreshAccessToken').mockRejectedValue(error);
    const fetchQuota = vi.spyOn(GoogleAPIService, 'fetchQuota');

    await expect(refreshAccountQuotaCore(stored.id)).rejects.toBe(error);
    expect(CloudAccountRepo.setAccountStatus).not.toHaveBeenCalled();
    expect(fetchQuota).not.toHaveBeenCalled();
  });

  it('marks a durable refresh block and returns the login-expired error', async () => {
    const stored = account(1);
    vi.spyOn(CloudAccountRepo, 'getAccount').mockResolvedValue(stored);
    vi.spyOn(CloudAccountRefreshService, 'refreshAccessToken').mockRejectedValue(
      new CloudAccountRefreshBlockedError(stored.id),
    );

    await expect(refreshAccountQuotaCore(stored.id)).rejects.toMatchObject({
      code: 'CLOUD_ACCOUNT_LOGIN_EXPIRED',
    });
    expect(CloudAccountRepo.setAccountStatus).toHaveBeenCalledWith(
      stored.id,
      'expired',
      CLOUD_ACCOUNT_REAUTH_REQUIRED_REASON,
      expect.any(Function),
    );
  });
});
