import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as electronMock from 'electron';
import { CloudMonitorService } from '@/modules/cloud-account/services/CloudMonitorService';
import { CloudAccountRepo } from '@/modules/cloud-account/persistence/cloudHandler';
import { CloudAccountSettingsStore } from '@/modules/cloud-account/persistence/cloud-account-settings-store';
import { GoogleAPIService } from '@/modules/cloud-account/services/GoogleAPIService';

vi.mock('@/modules/cloud-account/persistence/cloudHandler');
vi.mock('@/modules/cloud-account/persistence/cloud-account-settings-store');
vi.mock('@/modules/cloud-account/services/GoogleAPIService');
vi.mock('@/modules/cloud-account/services/AutoSwitchService');
vi.mock('@/shared/logging/logger');

describe('CloudMonitorService exhausted quota alerts', () => {
  let notificationShowSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    CloudMonitorService.resetStateForTesting();
    notificationShowSpy = vi.spyOn(
      (electronMock as { Notification: typeof electronMock.Notification }).Notification.prototype,
      'show',
    );

    vi.mocked(CloudAccountSettingsStore.getSetting).mockImplementation(
      (key: string, fallback: unknown) => {
        if (key === 'quota_alert_enabled') return true;
        if (key === 'quota_alert_threshold') return 20;
        if (key === 'ai_credits_alert_enabled') return false;
        if (key === 'language') return 'en';
        return fallback;
      },
    );
    vi.mocked(GoogleAPIService.fetchAICredits).mockResolvedValue(null as never);
  });

  afterEach(() => {
    CloudMonitorService.stop();
    notificationShowSpy.mockRestore();
    vi.useRealTimers();
  });

  it('alerts when a model quota reaches zero percent', async () => {
    vi.mocked(CloudAccountRepo.getAccounts).mockResolvedValue([
      {
        id: 'acc-zero',
        email: 'zero@example.com',
        token: {
          access_token: 'access-token',
          expiry_timestamp: Math.floor(Date.now() / 1000) + 3600,
        },
      },
    ] as never);
    vi.mocked(GoogleAPIService.fetchQuota).mockResolvedValue({
      models: {
        'models/gemini-test': {
          display_name: 'Gemini Test',
          percentage: 0,
        },
      },
    } as never);

    const pollPromise = CloudMonitorService.poll();
    await vi.advanceTimersByTimeAsync(1000);
    await pollPromise;

    expect(notificationShowSpy).toHaveBeenCalledTimes(1);
  });
});
