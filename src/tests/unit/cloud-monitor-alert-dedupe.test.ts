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
    vi.mocked(AutoSwitchService.checkAndSwitchIfNeeded).mockResolvedValue(false);
  });

  afterEach(() => {
    CloudMonitorService.resetStateForTesting();
    notificationShowSpy.mockRestore();
    vi.useRealTimers();
  });

  const account = {
    id: 'acc-1',
    email: 'user@example.com',
    token: {
      access_token: 'access-token',
      refresh_token: 'refresh-token',
      expiry_timestamp: 9_999_999_999,
    },
  };

  async function runPoll() {
    const pollPromise = CloudMonitorService.poll();
    await vi.advanceTimersByTimeAsync(1000);
    await pollPromise;
  }

  it('notifies once while a model remains below the quota threshold and notifies again after recovery', async () => {
    vi.mocked(CloudAccountRepo.getAccounts).mockResolvedValue([account] as never);
    vi.mocked(GoogleAPIService.fetchAICredits).mockResolvedValue(null as never);
    vi.mocked(GoogleAPIService.fetchQuota)
      .mockResolvedValueOnce({
        models: { 'models/gemini-test': { percentage: 10, display_name: 'Gemini Test' } },
      } as never)
      .mockResolvedValueOnce({
        models: { 'models/gemini-test': { percentage: 10, display_name: 'Gemini Test' } },
      } as never)
      .mockResolvedValueOnce({
        models: { 'models/gemini-test': { percentage: 80, display_name: 'Gemini Test' } },
      } as never)
      .mockResolvedValueOnce({
        models: { 'models/gemini-test': { percentage: 10, display_name: 'Gemini Test' } },
      } as never);
    vi.mocked(CloudAccountSettingsStore.getSetting).mockImplementation(
      (key: string, defaultValue: unknown) => {
        if (key === 'quota_alert_enabled') return true;
        if (key === 'quota_alert_threshold') return 20;
        if (key === 'ai_credits_alert_enabled') return false;
        if (key === 'language') return 'en';
        return defaultValue;
      },
    );

    await runPoll();
    expect(notificationShowSpy).toHaveBeenCalledTimes(1);

    await runPoll();
    expect(notificationShowSpy).toHaveBeenCalledTimes(1);

    await runPoll();
    expect(notificationShowSpy).toHaveBeenCalledTimes(1);

    await runPoll();
    expect(notificationShowSpy).toHaveBeenCalledTimes(2);
  });

  it('notifies once while AI credits remain low and rearms after the balance recovers', async () => {
    vi.mocked(CloudAccountRepo.getAccounts).mockResolvedValue([account] as never);
    vi.mocked(GoogleAPIService.fetchQuota).mockResolvedValue({ models: {} } as never);
    vi.mocked(GoogleAPIService.fetchAICredits)
      .mockResolvedValueOnce({ credits: 4000 } as never)
      .mockResolvedValueOnce({ credits: 4000 } as never)
      .mockResolvedValueOnce({ credits: 6000 } as never)
      .mockResolvedValueOnce({ credits: 4000 } as never);
    vi.mocked(CloudAccountSettingsStore.getSetting).mockImplementation(
      (key: string, defaultValue: unknown) => {
        if (key === 'quota_alert_enabled') return false;
        if (key === 'ai_credits_alert_enabled') return true;
        if (key === 'ai_credits_alert_threshold') return 5000;
        if (key === 'language') return 'en';
        return defaultValue;
      },
    );

    await runPoll();
    expect(notificationShowSpy).toHaveBeenCalledTimes(1);

    await runPoll();
    expect(notificationShowSpy).toHaveBeenCalledTimes(1);

    await runPoll();
    expect(notificationShowSpy).toHaveBeenCalledTimes(1);

    await runPoll();
    expect(notificationShowSpy).toHaveBeenCalledTimes(2);
  });
});
