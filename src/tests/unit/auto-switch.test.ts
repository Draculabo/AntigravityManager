import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CloudAccount, CloudQuotaData } from '@/modules/cloud-account/types';

vi.mock('@/modules/cloud-account/persistence/cloudHandler', () => ({
  CloudAccountRepo: {
    getAccounts: vi.fn(),
    getSetting: vi.fn(),
    getActiveAccountIdForTarget: vi.fn(),
  },
}));

vi.mock('@/modules/cloud-account/ipc/handler', () => ({
  switchCloudAccount: vi.fn(),
}));

vi.mock('@/shared/logging/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

function createAccount(
  id: string,
  quota: CloudQuotaData,
  options: Partial<CloudAccount> = {},
): CloudAccount {
  return {
    id,
    provider: 'google',
    email: `${id}@example.com`,
    token: {
      access_token: 'access-token',
      refresh_token: 'refresh-token',
      expires_in: 3600,
      expiry_timestamp: 1700000000,
      token_type: 'Bearer',
    },
    quota,
    created_at: 1700000000,
    last_used: 1700000000,
    status: 'active',
    ...options,
  };
}

function quotaWithClaudeGroup(modelPercentage: number, groupFraction: number): CloudQuotaData {
  return {
    models: {
      'claude-sonnet-4-5': {
        percentage: modelPercentage,
        resetTime: '',
      },
    },
    quota_groups: [
      {
        display_name: 'Claude and GPT models',
        buckets: [
          {
            bucket_id: '3p-5h',
            window: '5h',
            remaining_fraction: groupFraction,
            reset_time: '',
          },
        ],
      },
    ],
  };
}

describe('AutoSwitchService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('skips accounts whose Claude/GPT grouped quota bucket is depleted', async () => {
    const { CloudAccountRepo } = await import('@/modules/cloud-account/persistence/cloudHandler');
    const { AutoSwitchService } =
      await import('@/modules/cloud-account/services/AutoSwitchService');

    vi.mocked(CloudAccountRepo.getAccounts).mockResolvedValue([
      createAccount('current', quotaWithClaudeGroup(1, 0.01)),
      createAccount('model-high-group-low', quotaWithClaudeGroup(90, 0.02)),
      createAccount('model-medium-group-healthy', quotaWithClaudeGroup(45, 0.8)),
    ]);

    await expect(AutoSwitchService.findBestAccount('current')).resolves.toMatchObject({
      id: 'model-medium-group-healthy',
    });
  });
});
