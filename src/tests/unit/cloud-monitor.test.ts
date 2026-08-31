import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CloudMonitorService } from '@/modules/cloud-account/services/CloudMonitorService';
import { CloudAccountRepo } from '@/modules/cloud-account/persistence/cloudHandler';
import { CloudAccountSettingsStore } from '@/modules/cloud-account/persistence/cloud-account-settings-store';
import { WeeklyWarmupService } from '@/modules/cloud-account/services/WeeklyWarmupService';
import { GoogleAPIService } from '@/modules/cloud-account/services/GoogleAPIService';
import { AutoSwitchService } from '@/modules/cloud-account/services/AutoSwitchService';
import { AccountLeaseService } from '../../modules/proxy-gateway/server/modules/account-lease/account-lease.service';
import { logger } from '../../shared/logging/logger';
import * as electronMock from 'electron';

// Mock dependencies
vi.mock('@/modules/cloud-account/persistence/cloudHandler');
vi.mock('@/modules/cloud-account/persistence/cloud-account-settings-store');
vi.mock('@/modules/cloud-account/services/GoogleAPIService');
vi.mock('@/modules/cloud-account/services/AutoSwitchService');
vi.mock('../../shared/logging/logger');

describe('CloudMonitorService', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    vi.mocked(CloudAccountSettingsStore.getSetting).mockReset();
    vi.mocked(CloudAccountSettingsStore.getSetting).mockImplementation(
      (_key: string, defaultValue: unknown) => defaultValue,
    );
    CloudMonitorService.resetStateForTesting();
    vi.mocked(CloudAccountSettingsStore.readSetting).mockImplementation((key) =>
      CloudAccountSettingsStore.getSetting(key, undefined),
    );
  });

  afterEach(() => {
    CloudMonitorService.stop();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('should start polling on start() and set up interval', async () => {
    vi.mocked(CloudAccountSettingsStore.getSetting).mockReturnValue(true as never);
    const pollSpy = vi.spyOn(CloudMonitorService, 'poll').mockResolvedValue(undefined);

    CloudMonitorService.start();

    // Should call initial poll
    expect(pollSpy).toHaveBeenCalledTimes(1);

    // Fast forward 5 minutes
    await vi.advanceTimersByTimeAsync(1000 * 60 * 5);
    expect(pollSpy).toHaveBeenCalledTimes(2);
  });

  it('keeps the five-minute interval active when weekly warmup is enabled alone', async () => {
    vi.mocked(CloudAccountSettingsStore.getSetting).mockImplementation(
      (key: string, defaultValue: unknown) => {
        if (key === 'auto_switch_enabled') {
          return false as never;
        }
        if (key === 'weekly_warmup_config') {
          return { enabled: true, groups: ['claude', 'gemini'] } as never;
        }
        return defaultValue as never;
      },
    );
    const pollSpy = vi.spyOn(CloudMonitorService, 'poll').mockResolvedValue(undefined);

    CloudMonitorService.start();
    await vi.advanceTimersByTimeAsync(1000 * 60 * 5);

    expect(pollSpy).toHaveBeenCalledTimes(2);
  });

  it('warms an eligible weekly bucket once and refreshes its quota afterward', async () => {
    vi.setSystemTime(new Date('2026-09-01T00:05:00Z'));
    const account = {
      id: 'weekly-account',
      provider: 'google',
      email: 'weekly@example.com',
      token: {
        access_token: 'weekly-token',
        refresh_token: 'weekly-refresh',
        expiry_timestamp: Math.floor(Date.now() / 1000) + 3600,
        project_id: 'weekly-project',
      },
      status: 'active',
      quota: { models: {} },
    };
    const weeklyQuota = {
      models: {},
      quota_groups: [
        {
          display_name: 'Claude Models',
          buckets: [
            {
              bucket_id: 'claude-weekly',
              window: 'weekly',
              remaining_fraction: 1,
              reset_time: '2026-09-01T00:00:00Z',
            },
          ],
        },
      ],
    };
    vi.mocked(CloudAccountRepo.getAccounts).mockResolvedValue([account] as never);
    vi.mocked(GoogleAPIService.fetchQuota).mockResolvedValue(weeklyQuota as never);
    vi.mocked(CloudAccountSettingsStore.getSetting).mockImplementation(
      (key: string, defaultValue: unknown) => {
        if (key === 'weekly_warmup_config') {
          return { enabled: true, groups: ['claude'] } as never;
        }
        return defaultValue as never;
      },
    );
    const warmup = vi.fn().mockResolvedValue(undefined);
    CloudMonitorService.configureWeeklyWarmupExecutor({ warmup });

    const pollPromise = CloudMonitorService.poll();
    await vi.advanceTimersByTimeAsync(1000);
    await pollPromise;

    expect(warmup).toHaveBeenCalledExactlyOnceWith({
      accessToken: 'weekly-token',
      model: 'claude-sonnet-4-6',
      projectId: 'weekly-project',
      upstreamProxyUrl: undefined,
      signal: expect.any(AbortSignal),
    });
    expect(GoogleAPIService.fetchQuota).toHaveBeenCalledTimes(2);
    expect(CloudAccountRepo.updateQuota).toHaveBeenCalledTimes(2);
    expect(CloudAccountSettingsStore.setSetting).toHaveBeenCalledWith(
      'weekly_warmup_history',
      expect.objectContaining({ version: 1 }),
    );
  });

  it.each(['refresh fails', 'stopped during refresh'])(
    'does not schedule warmup when %s',
    async (scenario) => {
      const account = {
        id: 'freshness-account',
        provider: 'google',
        email: 'fixture@example.com',
        token: { access_token: 'fixture', expiry_timestamp: Date.now() / 1000 + 3600 },
        quota: { models: {} },
      };
      vi.mocked(CloudAccountRepo.getAccounts).mockResolvedValue([account] as never);
      vi.mocked(CloudAccountSettingsStore.readSetting).mockImplementation((key) =>
        key === 'weekly_warmup_config' ? { enabled: true, groups: ['gemini'] } : undefined,
      );
      vi.mocked(GoogleAPIService.fetchQuota).mockImplementation(async () => {
        if (scenario === 'refresh fails') {
          throw new Error('quota unavailable');
        }
        CloudMonitorService.stop();
        return { models: {} };
      });
      const run = vi.spyOn(WeeklyWarmupService, 'run').mockResolvedValue([]);
      CloudMonitorService.configureWeeklyWarmupExecutor({ warmup: vi.fn() });
      const poll = CloudMonitorService.poll();
      await vi.advanceTimersByTimeAsync(1000);
      await poll;
      if (scenario === 'refresh fails') {
        expect(run).toHaveBeenCalledExactlyOnceWith([], expect.anything());
      } else {
        expect(run).not.toHaveBeenCalled();
      }
    },
  );

  it('should poll accounts correctly', async () => {
    const mockAccounts = [
      {
        id: 'acc1',
        email: 'test@example.com',
        token: { access_token: 'valid_token', expiry_timestamp: Date.now() / 1000 + 3600 },
      },
    ];

    vi.mocked(CloudAccountRepo.getAccounts).mockResolvedValue(mockAccounts as never);
    vi.mocked(GoogleAPIService.fetchQuota).mockResolvedValue({ models: {} } as never);

    // Start poll but don't await immediately, as it pauses
    const pollPromise = CloudMonitorService.poll();

    // Advance time to pass the 1s sleep
    await vi.advanceTimersByTimeAsync(1000);

    // Now await
    await pollPromise;

    expect(CloudAccountRepo.getAccounts).toHaveBeenCalled();
    expect(GoogleAPIService.fetchQuota).toHaveBeenCalledWith('valid_token', undefined);
    expect(CloudAccountRepo.updateQuota).toHaveBeenCalledWith('acc1', expect.anything());
    expect(CloudAccountRepo.updateLastUsed).not.toHaveBeenCalled();
    expect(AutoSwitchService.checkAndSwitchIfNeeded).toHaveBeenCalled();
  });

  it('should refresh token if expired during poll', async () => {
    const mockAccounts = [
      {
        id: 'acc1',
        email: 'expired@example.com',
        token: {
          access_token: 'old_token',
          refresh_token: 'ref_token',
          expiry_timestamp: Math.floor(Date.now() / 1000) - 100, // Expired
        },
      },
    ];

    vi.mocked(CloudAccountRepo.getAccounts).mockResolvedValue(mockAccounts as never);
    vi.mocked(GoogleAPIService.refreshAccessToken).mockResolvedValue({
      access_token: 'new_token',
      refresh_token: 'new_ref_token',
      id_token: 'new_id_token',
      expires_in: 3600,
      token_type: 'Bearer',
    });
    vi.mocked(GoogleAPIService.fetchQuota).mockResolvedValue({ models: {} } as never);

    // Same async pattern
    const pollPromise = CloudMonitorService.poll();
    await vi.advanceTimersByTimeAsync(1000);
    await pollPromise;

    expect(GoogleAPIService.refreshAccessToken).toHaveBeenCalledWith(
      'ref_token',
      undefined,
      undefined,
    );
    expect(CloudAccountRepo.updateToken).toHaveBeenCalledWith(
      'acc1',
      expect.objectContaining({
        access_token: 'new_token',
        refresh_token: 'new_ref_token',
        id_token: 'new_id_token',
      }),
    );
    expect(GoogleAPIService.fetchQuota).toHaveBeenCalledWith('new_token', undefined);
  });

  it('should recover from 401 Unauthorized during quota fetch by refreshing token and retrying', async () => {
    const mockAccounts = [
      {
        id: 'acc-401',
        email: 'unauthorized@example.com',
        token: {
          access_token: 'stale_token',
          refresh_token: 'valid_refresh_token',
          expiry_timestamp: Math.floor(Date.now() / 1000) + 3600, // Token looks valid locally
        },
      },
    ];

    vi.mocked(CloudAccountRepo.getAccounts).mockResolvedValue(mockAccounts as never);
    vi.mocked(GoogleAPIService.fetchQuota)
      .mockRejectedValueOnce(new Error('UNAUTHORIZED'))
      .mockResolvedValueOnce({
        models: { 'models/gemini-pro': { percentage: 80, resetTime: '2026-08-27T00:00:00Z' } },
      } as never);

    vi.mocked(GoogleAPIService.refreshAccessToken).mockResolvedValue({
      access_token: 'refreshed_access_token',
      refresh_token: 'valid_refresh_token',
      id_token: 'refreshed_id_token',
      expires_in: 3600,
      token_type: 'Bearer',
    });

    const pollPromise = CloudMonitorService.poll();
    await vi.advanceTimersByTimeAsync(1000);
    await pollPromise;

    expect(GoogleAPIService.refreshAccessToken).toHaveBeenCalledWith(
      'valid_refresh_token',
      undefined,
      undefined,
    );
    expect(CloudAccountRepo.updateToken).toHaveBeenCalledWith(
      'acc-401',
      expect.objectContaining({
        access_token: 'refreshed_access_token',
      }),
    );
    expect(GoogleAPIService.fetchQuota).toHaveBeenNthCalledWith(1, 'stale_token', undefined);
    expect(GoogleAPIService.fetchQuota).toHaveBeenNthCalledWith(
      2,
      'refreshed_access_token',
      undefined,
    );
    expect(CloudAccountRepo.updateQuota).toHaveBeenCalledWith('acc-401', expect.anything());
    expect(CloudAccountRepo.setAccountStatus).toHaveBeenCalledWith('acc-401', 'active', null);
  });

  it('should recover from 401 Unauthorized during AI credits fetch', async () => {
    const mockAccounts = [
      {
        id: 'credits-401',
        email: 'credits-unauthorized@example.com',
        token: {
          access_token: 'stale_token',
          refresh_token: 'valid_refresh_token',
          expiry_timestamp: Math.floor(Date.now() / 1000) + 3600,
        },
      },
    ];

    vi.mocked(CloudAccountRepo.getAccounts).mockResolvedValue(mockAccounts as never);
    vi.mocked(GoogleAPIService.fetchQuota).mockResolvedValue({ models: {} } as never);
    vi.mocked(GoogleAPIService.fetchAICredits)
      .mockRejectedValueOnce(new Error('UNAUTHORIZED'))
      .mockResolvedValueOnce({ credits: 1234, expiryDate: '2026-09-01T00:00:00Z' });
    vi.mocked(GoogleAPIService.refreshAccessToken).mockResolvedValue({
      access_token: 'refreshed_access_token',
      refresh_token: 'valid_refresh_token',
      id_token: 'refreshed_id_token',
      expires_in: 3600,
      token_type: 'Bearer',
    });

    const pollPromise = CloudMonitorService.poll();
    await vi.advanceTimersByTimeAsync(1000);
    await pollPromise;

    expect(CloudAccountRepo.updateToken).toHaveBeenCalledWith(
      'credits-401',
      expect.objectContaining({ access_token: 'refreshed_access_token' }),
    );
    expect(GoogleAPIService.fetchAICredits).toHaveBeenNthCalledWith(1, 'stale_token', undefined);
    expect(GoogleAPIService.fetchAICredits).toHaveBeenNthCalledWith(
      2,
      'refreshed_access_token',
      undefined,
    );
    expect(CloudAccountRepo.updateQuota).toHaveBeenCalledWith(
      'credits-401',
      expect.objectContaining({
        ai_credits: { credits: 1234, expiryDate: '2026-09-01T00:00:00Z' },
      }),
    );
  });

  it('should share in-flight poll promise for concurrent poll() calls', async () => {
    let resolveGetAccounts: (value: unknown) => void;
    const getAccountsPromise = new Promise((resolve) => {
      resolveGetAccounts = resolve;
    });
    vi.mocked(CloudAccountRepo.getAccounts).mockImplementation(() => getAccountsPromise as never);
    vi.mocked(GoogleAPIService.fetchQuota).mockResolvedValue({ models: {} } as never);

    const poll1 = CloudMonitorService.poll();
    const poll2 = CloudMonitorService.poll();

    resolveGetAccounts!([
      {
        id: 'acc1',
        email: 'concurrent@example.com',
        token: { access_token: 'tok', expiry_timestamp: Math.floor(Date.now() / 1000) + 3600 },
      },
    ]);

    await vi.advanceTimersByTimeAsync(1000);
    await Promise.all([poll1, poll2]);

    expect(CloudAccountRepo.getAccounts).toHaveBeenCalledTimes(1);
  });

  describe('handleAppFocus (Smart Refresh)', () => {
    it('should trigger poll when focused after debounce time', async () => {
      const pollSpy = vi.spyOn(CloudMonitorService, 'poll').mockResolvedValue(undefined);

      CloudMonitorService.start();
      vi.setSystemTime(Date.now() + 20000);

      await CloudMonitorService.handleAppFocus();

      // Called once by start, once by focus
      expect(pollSpy).toHaveBeenCalledTimes(2);
    });

    it('should NOT trigger poll if debounced (focused too soon)', async () => {
      const pollSpy = vi.spyOn(CloudMonitorService, 'poll').mockResolvedValue(undefined);

      CloudMonitorService.start();

      vi.setSystemTime(Date.now() + 1000);

      await CloudMonitorService.handleAppFocus();

      // Called once by start, 0 by focus
      expect(pollSpy).toHaveBeenCalledTimes(1);
      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('debounce active'));
    });

    it('should NOT trigger poll if already polling (concurrency guard)', async () => {
      // Let's spy on poll to silence start's poll
      const pollSpy = vi.spyOn(CloudMonitorService, 'poll').mockResolvedValue(undefined);
      CloudMonitorService.start();
      pollSpy.mockRestore(); // Restore so we can test the real guard logic

      vi.setSystemTime(Date.now() + 20000);

      // 2. Mock getAccounts to delay
      let resolveGetAccounts: (value: unknown) => void;
      const getAccountsPromise = new Promise((resolve) => {
        resolveGetAccounts = resolve;
      });
      vi.mocked(CloudAccountRepo.getAccounts).mockImplementation(() => getAccountsPromise as never);

      // 3. Trigger first focus -> starts poll, hangs at getAccounts or sleep
      // Actually poll() calls getAccounts first thing.
      const p1 = CloudMonitorService.handleAppFocus();

      // Allow p1 to start execution and enter poll()
      // We invoke one run loop
      // But since everything is sync until first await, it should enter poll, set isPolling=true, call getAccounts, and await.

      // 4. Trigger second focus immediately
      const p2 = CloudMonitorService.handleAppFocus();

      // 5. Release the first poll
      resolveGetAccounts!([
        { id: '1', token: { access_token: 'tok', expiry_timestamp: 9999999999 } },
      ]);

      // Advance timer for the 1s sleep inside poll
      await vi.advanceTimersByTimeAsync(1000);

      await Promise.all([p1, p2]);

      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('polling is already in progress'),
      );
      // getAccounts should be called once (by the first unblocked poll)
      // The second one blocked by guard before calling poll
      expect(CloudAccountRepo.getAccounts).toHaveBeenCalledTimes(1);
    });

    it('should reset interval after successful focus poll', async () => {
      const clearIntervalSpy = vi.spyOn(global, 'clearInterval');
      const setIntervalSpy = vi.spyOn(global, 'setInterval');

      // Spy on poll to consume the start() call
      const pollSpy = vi.spyOn(CloudMonitorService, 'poll').mockResolvedValue(undefined);
      CloudMonitorService.start();
      pollSpy.mockRestore(); // Restore real poll

      vi.setSystemTime(Date.now() + 20000);

      // Needs to handle async poll
      vi.mocked(CloudAccountRepo.getAccounts).mockResolvedValue([]);

      const focusPromise = CloudMonitorService.handleAppFocus();
      await vi.advanceTimersByTimeAsync(1000); // For poll sleep
      await focusPromise;

      expect(clearIntervalSpy).toHaveBeenCalled();
      // 1 for start (initial), 1 for reset = 2
      expect(setIntervalSpy).toHaveBeenCalledTimes(2);
    });
  });
});

describe('CloudMonitorService AI credits alert', () => {
  let notificationShowSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    CloudMonitorService.resetStateForTesting();

    // Spy on the Notification class exported from the electron mock (same binding used by CloudMonitorService)
    notificationShowSpy = vi.spyOn(
      (electronMock as { Notification: typeof electronMock.Notification }).Notification.prototype,
      'show',
    );
  });

  afterEach(() => {
    CloudMonitorService.stop();
    vi.useRealTimers();
    notificationShowSpy.mockRestore();
  });

  function makeAccount(id: string, email: string, credits?: number) {
    return {
      id,
      email,
      token: { access_token: 'tok', expiry_timestamp: 9999999999 },
      quota: credits !== undefined ? { ai_credits: { credits } } : undefined,
    };
  }

  function setupPoll(
    accounts: ReturnType<typeof makeAccount>[],
    alertEnabled: boolean,
    threshold: number,
  ) {
    vi.mocked(CloudAccountRepo.getAccounts).mockResolvedValue(accounts as never);
    vi.mocked(GoogleAPIService.fetchQuota).mockResolvedValue({ models: {} } as never);
    vi.mocked(GoogleAPIService.fetchAICredits).mockResolvedValue(null as never);
    vi.mocked(CloudAccountSettingsStore.getSetting).mockImplementation(
      (key: string, def: unknown) => {
        if (key === 'ai_credits_alert_enabled') return alertEnabled;
        if (key === 'ai_credits_alert_threshold') return threshold;
        if (key === 'quota_alert_enabled') return false;
        if (key === 'language') return 'en';
        return def;
      },
    );
  }

  it('fires a notification when credits are below threshold', async () => {
    setupPoll([makeAccount('acc1', 'user@example.com', 4000)], true, 5000);

    const pollPromise = CloudMonitorService.poll();
    await vi.advanceTimersByTimeAsync(1000);
    await pollPromise;

    expect(notificationShowSpy).toHaveBeenCalledTimes(1);
  });

  it('fires a notification when credits are exactly at threshold (boundary)', async () => {
    setupPoll([makeAccount('acc1', 'user@example.com', 5000)], true, 5000);

    const pollPromise = CloudMonitorService.poll();
    await vi.advanceTimersByTimeAsync(1000);
    await pollPromise;

    expect(notificationShowSpy).toHaveBeenCalledTimes(1);
  });

  it('does NOT fire when credits are above threshold', async () => {
    setupPoll([makeAccount('acc1', 'user@example.com', 6000)], true, 5000);

    const pollPromise = CloudMonitorService.poll();
    await vi.advanceTimersByTimeAsync(1000);
    await pollPromise;

    expect(notificationShowSpy).not.toHaveBeenCalled();
  });

  it('does NOT fire when alert is disabled', async () => {
    setupPoll([makeAccount('acc1', 'user@example.com', 1000)], false, 5000);

    const pollPromise = CloudMonitorService.poll();
    await vi.advanceTimersByTimeAsync(1000);
    await pollPromise;

    expect(notificationShowSpy).not.toHaveBeenCalled();
  });

  it('does NOT crash and does NOT fire when account has no ai_credits data', async () => {
    setupPoll([makeAccount('acc1', 'user@example.com', undefined)], true, 5000);

    const pollPromise = CloudMonitorService.poll();
    await vi.advanceTimersByTimeAsync(1000);
    await pollPromise;

    expect(notificationShowSpy).not.toHaveBeenCalled();
  });

  it('only fires for accounts with credits at or below threshold in multi-account scenario', async () => {
    setupPoll(
      [
        makeAccount('acc1', 'low@example.com', 3000),
        makeAccount('acc2', 'high@example.com', 8000),
        makeAccount('acc3', 'exact@example.com', 5000),
      ],
      true,
      5000,
    );

    const pollPromise = CloudMonitorService.poll();
    await vi.advanceTimersByTimeAsync(3000); // 3 accounts * 1s sleep each
    await pollPromise;

    // acc1 (3000 <= 5000) and acc3 (5000 <= 5000) should fire; acc2 (8000 > 5000) should not
    expect(notificationShowSpy).toHaveBeenCalledTimes(2);
  });
});

describe('AccountLeaseService project-id hydration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it('hydrates missing project_id and persists it', async () => {
    const account = {
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
      last_used: 1,
    };

    vi.mocked(CloudAccountRepo.getAccounts).mockResolvedValue([account] as never);
    vi.mocked(CloudAccountRepo.getAccount).mockResolvedValue(account as never);
    vi.mocked(CloudAccountRepo.updateToken).mockResolvedValue(undefined as never);
    vi.mocked(GoogleAPIService.fetchProjectId).mockResolvedValue('resolved-project' as never);

    const service = new AccountLeaseService();
    const selectedToken = await service.getNextToken();

    expect(GoogleAPIService.fetchProjectId).toHaveBeenCalledWith('access-token');
    expect(CloudAccountRepo.updateToken).toHaveBeenCalledWith(
      'acc-1',
      expect.objectContaining({
        project_id: 'resolved-project',
      }),
    );
    expect(selectedToken?.token.project_id).toBe('resolved-project');
  });

  it('keeps existing valid project_id without extra fetch', async () => {
    const account = {
      id: 'acc-2',
      provider: 'google',
      email: 'existing@example.com',
      token: {
        access_token: 'access-token-2',
        refresh_token: 'refresh-token-2',
        token_type: 'Bearer',
        expires_in: 3600,
        expiry_timestamp: Math.floor(Date.now() / 1000) + 3600,
        project_id: 'existing-project',
      },
      created_at: 1,
      last_used: 1,
    };

    vi.mocked(CloudAccountRepo.getAccounts).mockResolvedValue([account] as never);
    vi.mocked(GoogleAPIService.fetchProjectId).mockResolvedValue('new-project' as never);

    const service = new AccountLeaseService();
    const selectedToken = await service.getNextToken();

    expect(GoogleAPIService.fetchProjectId).not.toHaveBeenCalled();
    expect(selectedToken?.token.project_id).toBe('existing-project');
  });

  it('uses fallback project_id when project_id cannot be resolved', async () => {
    const account = {
      id: 'acc-3',
      provider: 'google',
      email: 'missing@example.com',
      token: {
        access_token: 'access-token-3',
        refresh_token: 'refresh-token-3',
        token_type: 'Bearer',
        expires_in: 3600,
        expiry_timestamp: Math.floor(Date.now() / 1000) + 3600,
        project_id: 'cloud-code-123',
      },
      created_at: 1,
      last_used: 1,
    };

    vi.mocked(CloudAccountRepo.getAccounts).mockResolvedValue([account] as never);
    vi.mocked(GoogleAPIService.fetchProjectId).mockResolvedValue(null as never);

    const service = new AccountLeaseService();
    const selectedToken = await service.getNextToken();

    expect(GoogleAPIService.fetchProjectId).toHaveBeenCalledWith('access-token-3');
    expect(CloudAccountRepo.updateToken).not.toHaveBeenCalled();
    expect(selectedToken?.token.project_id).toBe('silver-orbit-5m7qc');
  });

  it('rehydrates malformed legacy resource-style project_id values', async () => {
    const account = {
      id: 'acc-4',
      provider: 'google',
      email: 'legacy@example.com',
      token: {
        access_token: 'access-token-4',
        refresh_token: 'refresh-token-4',
        token_type: 'Bearer',
        expires_in: 3600,
        expiry_timestamp: Math.floor(Date.now() / 1000) + 3600,
        project_id: 'projects/',
      },
      created_at: 1,
      last_used: 1,
    };

    vi.mocked(CloudAccountRepo.getAccounts).mockResolvedValue([account] as never);
    vi.mocked(CloudAccountRepo.getAccount).mockResolvedValue(account as never);
    vi.mocked(CloudAccountRepo.updateToken).mockResolvedValue(undefined as never);
    vi.mocked(GoogleAPIService.fetchProjectId).mockResolvedValue('resolved-project-4' as never);

    const service = new AccountLeaseService();
    const selectedToken = await service.getNextToken();

    expect(GoogleAPIService.fetchProjectId).toHaveBeenCalledWith('access-token-4');
    expect(CloudAccountRepo.updateToken).toHaveBeenCalledWith(
      'acc-4',
      expect.objectContaining({
        project_id: 'resolved-project-4',
      }),
    );
    expect(selectedToken?.token.project_id).toBe('resolved-project-4');
  });
});
