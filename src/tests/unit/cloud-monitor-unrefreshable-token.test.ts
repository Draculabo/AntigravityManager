import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CloudMonitorService } from '@/modules/cloud-account/services/CloudMonitorService';
import { CloudAccountRepo } from '@/modules/cloud-account/persistence/cloudHandler';
import { GoogleAPIService } from '@/modules/cloud-account/services/GoogleAPIService';

vi.mock('@/modules/cloud-account/persistence/cloudHandler');
vi.mock('@/modules/cloud-account/persistence/cloud-account-settings-store');
vi.mock('@/modules/cloud-account/services/GoogleAPIService');
vi.mock('@/modules/cloud-account/services/AutoSwitchService');
vi.mock('@/shared/logging/logger');

describe('CloudMonitorService unrefreshable tokens', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-17T05:00:00Z'));
    vi.clearAllMocks();
    CloudMonitorService.resetStateForTesting();
  });

  afterEach(() => {
    CloudMonitorService.stop();
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
    expect(GoogleAPIService.fetchQuota).toHaveBeenCalledWith(
      'still-valid-access-token',
      undefined,
    );
  });
});
