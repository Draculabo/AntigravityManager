import { describe, expect, it, vi } from 'vitest';
import type { CloudAccount } from '@/modules/cloud-account/types';
import { localAccountPostImportService } from '@/modules/cloud-account/local-import/local-account-post-import.service';
import { refreshAccountQuotaCore } from '@/modules/cloud-account/services/cloud-account-quota-refresh.service';
import { cloudAccountWeeklyWarmupRunner } from '@/modules/cloud-account/services/cloud-account-weekly-warmup-runner';
import { reloadNestServerAccountLeaseCache } from '@/server/main';

function account(id: string): CloudAccount {
  return {
    id,
    provider: 'google',
    email: `${id}@example.com`,
    token: {
      access_token: 'access',
      refresh_token: 'refresh',
      expires_in: 3600,
      expiry_timestamp: 3600,
      token_type: 'Bearer',
    },
    created_at: 1,
    last_used: 1,
  };
}

vi.mock('@/modules/cloud-account/services/cloud-account-quota-refresh.service', () => ({
  refreshAccountQuotaCore: vi.fn(async (id: string) => account(id)),
}));
vi.mock('@/modules/cloud-account/services/cloud-account-weekly-warmup-runner', () => ({
  cloudAccountWeeklyWarmupRunner: { schedule: vi.fn() },
}));
vi.mock('@/server/main', () => ({
  reloadNestServerAccountLeaseCache: vi.fn(async () => true),
}));
vi.mock('@/shared/logging/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

describe('default post-import composition', () => {
  it('schedules Node-safe warmup only after successful quota hydration', async () => {
    vi.clearAllMocks();
    vi.mocked(refreshAccountQuotaCore).mockImplementation(async (id) => {
      if (id === 'failed') {
        throw new Error('refresh failed');
      }
      return account(id);
    });

    const taskId = localAccountPostImportService.schedule(['refreshed', 'failed']);
    await vi.waitFor(
      () => {
        expect(localAccountPostImportService.getStatus(taskId!)?.status).toBe('completed');
      },
      { timeout: 12_000 },
    );

    expect(cloudAccountWeeklyWarmupRunner.schedule).toHaveBeenCalledExactlyOnceWith([
      account('refreshed'),
    ]);
    expect(reloadNestServerAccountLeaseCache).toHaveBeenCalledOnce();
    expect(localAccountPostImportService.getStatus(taskId!)?.failedAccountIds).toEqual(['failed']);
  }, 15_000);
});
