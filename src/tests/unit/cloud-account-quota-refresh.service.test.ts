import { beforeEach, describe, expect, it, vi } from 'vitest';
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
import { proxyModelAvailabilityStore } from '@/modules/proxy-gateway/server/shared/services/model-availability.service';

vi.mock('@/modules/cloud-account/services/CloudAccountHealthService', () => ({
  clearValidationHealthAfterSuccessfulProbe: vi.fn(async () => {}),
}));
vi.mock('@/modules/proxy-gateway/server/shared/services/model-availability.service', () => ({
  proxyModelAvailabilityStore: { clearCapabilityFailures: vi.fn() },
}));
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
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    vi.spyOn(CloudAccountRepo, 'updateToken').mockResolvedValue();
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

    const result = await refreshAccountQuotaCore(stored.id, { onPrimarySuccess, onRetrySuccess });

    expect(result).toBe(stored);
    expect(result.quota).toEqual({
      models: { gemini: { percentage: 90, resetTime: 'soon' } },
      ai_credits: { credits: 4, expiryDate: 'later' },
    });
    expect(CloudAccountRepo.updateQuota).toHaveBeenCalledWith(stored.id, result.quota);
    expect(CloudAccountRepo.updateLastUsed).toHaveBeenCalledWith(stored.id);
    expect(CloudAccountRepo.setAccountStatus).toHaveBeenCalledWith(stored.id, 'active', null);
    expect(clearValidationHealthAfterSuccessfulProbe).toHaveBeenCalledWith(stored);
    expect(proxyModelAvailabilityStore.clearCapabilityFailures).toHaveBeenCalledWith(stored.id);
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
    expect(CloudAccountRepo.updateToken).toHaveBeenCalledWith(stored.id, result.token);
    expect(result.token.refresh_token).toBe('new-refresh');
    expect(result.quota?.ai_credits).toEqual({ credits: 4, expiryDate: 'later' });
    expect(onPrimarySuccess).not.toHaveBeenCalled();
    expect(onRetrySuccess).toHaveBeenCalledOnce();
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
    expect(CloudAccountRepo.updateToken).toHaveBeenCalledOnce();
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
    );
  });
});
