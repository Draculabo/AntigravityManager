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

describe('CloudMonitorService zero quota alerts', () => {
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
        id: 'acc-zero-quota',
        email: 'zero@example.com',
        token: {
          access_token: 'access-token',
          refresh_token: 'refresh-token',
          expiry_timestamp: 9_999_999_999,
        },
      },
    ] as never);

    vi.mocked(GoogleAPIService.fetchQuota).mockResolvedValue({
      models: {
        'models/gemini-zero': {
          percentage: 0,
          display_name: 'Gemini Zero',
        },
      },
    } as never);
    vi.mocked(GoogleAPIService.fetchAICredits).mockResolvedValue(null as never);

    vi.mocked(CloudAccountSettingsStore.getSetting).mockImplementation(
      (key: string, defaultValue: unknown) => {
        if (key === 'quota_alert_enabled') return true;
        if (key === 'quota_alert_threshold') return 20;
        if (key === 'ai_credits_alert_enabled') return false;
        if (key === 'language') return 'en';
        return defaultValue;
      },
    );
  });

  afterEach(() => {
    CloudMonitorService.stop();
    vi.useRealTimers();
    notificationShowSpy.mockRestore();
  });

  it('notifies when a model quota is fully exhausted', async () => {
    const pollPromise = CloudMonitorService.poll();
    await vi.advanceTimersByTimeAsync(1000);
    await pollPromise;

    expect(notificationShowSpy).toHaveBeenCalledTimes(1);
    expect(AutoSwitchService.checkAndSwitchIfNeeded).toHaveBeenCalled();
  });
});
