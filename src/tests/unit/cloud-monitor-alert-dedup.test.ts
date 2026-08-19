import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as electronMock from 'electron';
import { CloudMonitorService } from '@/modules/cloud-account/services/CloudMonitorService';
import { CloudAccountRepo } from '@/modules/cloud-account/persistence/cloudHandler';
import { CloudAccountSettingsStore } from '@/modules/cloud-account/persistence/cloud-account-settings-store';
import { GoogleAPIService } from '@/modules/cloud-account/services/GoogleAPIService';
import { AutoSwitchService } from '@/modules/cloud-account/services/AutoSwitchService';

vi.mock('@/modules/cloud-account/persistence/cloudHandler');
vi.mock('@/modules/cloud-account/persistence/cloud-account-settings-store');
vi.mock('@/modules/cloud-account/services/GoogleAPIService');
vi.mock('@/modules/cloud-account/services/AutoSwitchService');

describe('CloudMonitorService alert deduplication', () => {
  let notificationShowSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    CloudMonitorService.resetStateForTesting();
    notificationShowSpy = vi.spyOn(
      (electronMock as { Notification: typeof electronMock.Notification }).Notification.prototype,
      'show',
    );

    vi.mocked(CloudAccountRepo.getAccounts).mockResolvedValue([
      {
        id: 'acc-1',
        email: 'user@example.com',
        token: {
          access_token: 'access-token',
          expiry_timestamp: 9999999999,
        },
      },
    ] as never);
    vi.mocked(GoogleAPIService.fetchAICredits).mockResolvedValue(null as never);
    vi.mocked(CloudAccountSettingsStore.getSetting).mockImplementation(
      (key: string, fallback: unknown) => {
        if (key === 'quota_alert_enabled') return true;
        if (key === 'quota_alert_threshold') return 20;
        if (key === 'ai_credits_alert_enabled') return false;
        if (key === 'language') return 'en';
        return fallback;
      },
    );
  });

  afterEach(() => {
    CloudMonitorService.resetStateForTesting();
    notificationShowSpy.mockRestore();
    vi.useRealTimers();
  });

  async function pollWithPercentage(percentage: number): Promise<void> {
    vi.mocked(GoogleAPIService.fetchQuota).mockResolvedValueOnce({
      models: {
        'models/gemini-test': {
          percentage,
          display_name: 'Gemini Test',
        },
      },
    } as never);

    const pollPromise = CloudMonitorService.poll();
    await vi.advanceTimersByTimeAsync(1000);
    await pollPromise;
  }

  it('notifies only when an account enters the low-quota state', async () => {
    await pollWithPercentage(10);
    await pollWithPercentage(10);

    expect(notificationShowSpy).toHaveBeenCalledTimes(1);

    await pollWithPercentage(80);
    await pollWithPercentage(10);

    expect(notificationShowSpy).toHaveBeenCalledTimes(2);
    expect(AutoSwitchService.checkAndSwitchIfNeeded).toHaveBeenCalled();
  });
});
