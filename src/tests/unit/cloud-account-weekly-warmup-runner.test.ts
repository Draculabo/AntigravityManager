import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CloudAccountRepo } from '@/modules/cloud-account/persistence/cloudHandler';
import type { CloudAccount, CloudQuotaData } from '@/modules/cloud-account/types';
import { GoogleAPIService } from '@/modules/cloud-account/services/GoogleAPIService';
import { WeeklyWarmupService } from '@/modules/cloud-account/services/WeeklyWarmupService';
import { CloudAccountWeeklyWarmupRunner } from '@/modules/cloud-account/services/cloud-account-weekly-warmup-runner';

vi.mock('@/shared/logging/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

function account(): CloudAccount {
  return {
    id: 'warmup-account',
    provider: 'google',
    email: 'warmup@example.com',
    token: {
      access_token: 'access',
      refresh_token: 'refresh',
      expires_in: 3600,
      expiry_timestamp: 3600,
      token_type: 'Bearer',
    },
    quota: {
      models: { gemini: { percentage: 10, resetTime: 'later' } },
      ai_credits: { credits: 3, expiryDate: 'later' },
    },
    created_at: 1,
    last_used: 1,
  };
}

describe('cloud account weekly warmup runner', () => {
  const runner = new CloudAccountWeeklyWarmupRunner();
  const executor = { warmup: vi.fn(async () => {}) };

  beforeEach(() => {
    vi.restoreAllMocks();
    runner.start();
    runner.configure(executor);
    vi.spyOn(WeeklyWarmupService, 'isEnabled').mockReturnValue(true);
    vi.spyOn(WeeklyWarmupService, 'run').mockResolvedValue(['warmup-account']);
    vi.spyOn(CloudAccountRepo, 'updateQuota').mockResolvedValue();
  });

  afterEach(async () => {
    runner.cancel();
    await runner.drain();
    vi.restoreAllMocks();
  });

  it('persists refreshed quota while retaining cached AI credits', async () => {
    const stored = account();
    vi.spyOn(GoogleAPIService, 'fetchQuota').mockResolvedValue({
      models: { gemini: { percentage: 80, resetTime: 'soon' } },
    });

    await runner.run([stored]);

    expect(WeeklyWarmupService.run).toHaveBeenCalledWith([stored], executor);
    expect(stored.quota).toEqual({
      models: { gemini: { percentage: 80, resetTime: 'soon' } },
      ai_credits: { credits: 3, expiryDate: 'later' },
    });
    expect(CloudAccountRepo.updateQuota).toHaveBeenCalledWith(stored.id, stored.quota);
  });

  it('does not run when the saved warmup configuration is disabled', async () => {
    vi.mocked(WeeklyWarmupService.isEnabled).mockReturnValue(false);

    await runner.run([account()]);

    expect(WeeklyWarmupService.run).not.toHaveBeenCalled();
    expect(CloudAccountRepo.updateQuota).not.toHaveBeenCalled();
  });

  it('cancels a pending quota fetch and drains before a persistence write', async () => {
    let completeFetch: (quota: CloudQuotaData) => void = () => {};
    vi.spyOn(GoogleAPIService, 'fetchQuota').mockImplementation(
      () =>
        new Promise((resolve) => {
          completeFetch = resolve;
        }),
    );
    const task = runner.run([account()]);
    await vi.waitFor(() => expect(GoogleAPIService.fetchQuota).toHaveBeenCalledOnce());

    runner.cancel();
    const drain = runner.drain();
    completeFetch({ models: {} });
    await Promise.all([task, drain]);

    expect(CloudAccountRepo.updateQuota).not.toHaveBeenCalled();
  });

  it('keeps fetch failures fail-soft without writing quota', async () => {
    vi.spyOn(GoogleAPIService, 'fetchQuota').mockRejectedValue(new Error('provider unavailable'));

    await expect(runner.run([account()])).resolves.toBeUndefined();

    expect(CloudAccountRepo.updateQuota).not.toHaveBeenCalled();
  });
});
