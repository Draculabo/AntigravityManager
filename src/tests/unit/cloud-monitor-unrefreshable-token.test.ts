import type { CloudAccount } from '@/modules/cloud-account/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CloudMonitorService } from '@/modules/cloud-account/services/CloudMonitorService';
import { CloudAccountRepo } from '@/modules/cloud-account/persistence/cloudHandler';
import {
  GoogleAPIService,
  OAuthTokenRefreshError,
} from '@/modules/cloud-account/services/GoogleAPIService';
import {
  CLOUD_ACCOUNT_REAUTH_REQUIRED_REASON,
  CloudAccountRefreshBlockedError,
  CloudAccountRefreshService,
} from '@/modules/cloud-account/services/CloudAccountRefreshService';

vi.mock('@/modules/cloud-account/persistence/cloudHandler');
vi.mock('@/modules/cloud-account/persistence/cloud-account-settings-store');
vi.mock('@/modules/cloud-account/services/GoogleAPIService', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('@/modules/cloud-account/services/GoogleAPIService')>();
  return {
    ...original,
    GoogleAPIService: {
      ...original.GoogleAPIService,
      fetchQuota: vi.fn(),
      refreshAccessToken: vi.fn(),
    },
  };
});
vi.mock('@/modules/cloud-account/services/AutoSwitchService');
vi.mock('@/shared/logging/logger');

describe('CloudMonitorService unrefreshable tokens', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-17T05:00:00Z'));
    vi.clearAllMocks();
    vi.mocked(CloudAccountRepo.getAccount).mockImplementation(async (id) => {
      const latest: CloudAccount[] | undefined = await vi
        .mocked(CloudAccountRepo.getAccounts)
        .mock.results.at(-1)?.value;
      return latest?.find((account) => account.id === id);
    });
    CloudMonitorService.resetStateForTesting();
  });

  afterEach(() => {
    CloudMonitorService.stop();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('marks an expired token without refresh token as expired without network refresh', async () => {
    const now = Math.floor(Date.now() / 1000);
    vi.mocked(CloudAccountRepo.getAccounts).mockResolvedValue([
      {
        id: 'expired-account',
        email: 'expired@example.com',
        token: {
          access_token: 'expired-access-token',
          expiry_timestamp: now - 1,
        },
      },
    ] as never);

    await CloudMonitorService.poll();

    expect(GoogleAPIService.refreshAccessToken).not.toHaveBeenCalled();
    expect(GoogleAPIService.fetchQuota).not.toHaveBeenCalled();
    expect(CloudAccountRepo.setAccountStatus).toHaveBeenCalledWith(
      'expired-account',
      'expired',
      'Access token expired and no refresh token is available',
      expect.any(Function),
    );
  });

  it('uses a still-valid access token until expiry when no refresh token exists', async () => {
    const now = Math.floor(Date.now() / 1000);
    vi.mocked(CloudAccountRepo.getAccounts).mockResolvedValue([
      {
        id: 'near-expiry-account',
        email: 'near-expiry@example.com',
        token: {
          access_token: 'still-valid-access-token',
          expiry_timestamp: now + 300,
        },
      },
    ] as never);
    vi.mocked(GoogleAPIService.fetchQuota).mockResolvedValue({ models: {} } as never);

    const pollPromise = CloudMonitorService.poll();
    await vi.advanceTimersByTimeAsync(1000);
    await pollPromise;

    expect(GoogleAPIService.refreshAccessToken).not.toHaveBeenCalled();
    expect(GoogleAPIService.fetchQuota).toHaveBeenCalledWith('still-valid-access-token', undefined);
  });

  it('does not mark the account expired after the first confirmed invalid_grant', async () => {
    const now = Math.floor(Date.now() / 1000);
    vi.mocked(CloudAccountRepo.getAccounts).mockResolvedValue([
      {
        id: 'first-strike-account',
        email: 'first-strike@example.com',
        token: {
          access_token: 'expired-access-token',
          refresh_token: 'refresh-token',
          expiry_timestamp: now - 1,
        },
      },
    ] as never);
    vi.spyOn(CloudAccountRefreshService, 'refreshAccessToken').mockRejectedValue(
      new OAuthTokenRefreshError('invalid_grant', 400, 'default', 'expired or revoked'),
    );

    await CloudMonitorService.poll();

    expect(CloudAccountRepo.setAccountStatus).not.toHaveBeenCalledWith(
      'first-strike-account',
      'expired',
      expect.anything(),
    );
  });

  it('marks the account expired only after the refresh coordinator blocks it', async () => {
    const now = Math.floor(Date.now() / 1000);
    vi.mocked(CloudAccountRepo.getAccounts).mockResolvedValue([
      {
        id: 'blocked-account',
        email: 'blocked@example.com',
        token: {
          access_token: 'expired-access-token',
          refresh_token: 'refresh-token',
          expiry_timestamp: now - 1,
        },
      },
    ] as never);
    vi.spyOn(CloudAccountRefreshService, 'refreshAccessToken').mockRejectedValue(
      new CloudAccountRefreshBlockedError('blocked-account'),
    );

    await CloudMonitorService.poll();

    expect(CloudAccountRepo.setAccountStatus).toHaveBeenCalledWith(
      'blocked-account',
      'expired',
      CLOUD_ACCOUNT_REAUTH_REQUIRED_REASON,
      expect.any(Function),
    );
  });
});
