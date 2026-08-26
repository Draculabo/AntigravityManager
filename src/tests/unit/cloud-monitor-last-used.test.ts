import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CloudMonitorService } from '@/modules/cloud-account/services/CloudMonitorService';
import { CloudAccountRepo } from '@/modules/cloud-account/persistence/cloudHandler';
import { CloudAccountSettingsStore } from '@/modules/cloud-account/persistence/cloud-account-settings-store';
import { GoogleAPIService } from '@/modules/cloud-account/services/GoogleAPIService';
import { AutoSwitchService } from '@/modules/cloud-account/services/AutoSwitchService';

vi.mock('electron', () => ({
  Notification: class {
    show() {}
  },
}));
vi.mock('@/modules/cloud-account/persistence/cloudHandler');
vi.mock('@/modules/cloud-account/persistence/cloud-account-settings-store');
vi.mock('@/modules/cloud-account/services/GoogleAPIService');
vi.mock('@/modules/cloud-account/services/AutoSwitchService');

describe('CloudMonitorService last-used semantics', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    CloudMonitorService.resetStateForTesting();
    vi.mocked(CloudAccountSettingsStore.getSetting).mockImplementation(
      (_key: string, defaultValue: unknown) => defaultValue,
    );
    vi.mocked(AutoSwitchService.checkAndSwitchIfNeeded).mockResolvedValue(false);
  });

  afterEach(() => {
    CloudMonitorService.stop();
    vi.useRealTimers();
  });

  it('does not mark an account as used when only quota polling succeeds', async () => {
    vi.mocked(CloudAccountRepo.getAccounts).mockResolvedValue([
      {
        id: 'acc-1',
        provider: 'google',
        email: 'user@example.com',
        token: {
          access_token: 'access-token',
          refresh_token: 'refresh-token',
          token_type: 'Bearer',
          expires_in: 3600,
          expiry_timestamp: Math.floor(Date.now() / 1000) + 3600,
        },
        created_at: 1,
        last_used: 123,
      },
    ] as never);
    vi.mocked(GoogleAPIService.fetchQuota).mockResolvedValue({ models: {} } as never);
    vi.mocked(GoogleAPIService.fetchAICredits).mockResolvedValue(null as never);

    const pollPromise = CloudMonitorService.poll();
    await vi.advanceTimersByTimeAsync(1000);
    await pollPromise;

    expect(CloudAccountRepo.updateQuota).toHaveBeenCalledWith('acc-1', expect.anything());
    expect(CloudAccountRepo.updateLastUsed).not.toHaveBeenCalled();
  });
});
