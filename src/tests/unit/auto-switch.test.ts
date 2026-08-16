import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CloudAccount, CloudQuotaData } from '@/modules/cloud-account/types';

vi.mock('@/modules/cloud-account/persistence/cloudHandler', () => ({
  CloudAccountRepo: {
    getAccounts: vi.fn(),
  },
}));

vi.mock('@/modules/cloud-account/persistence/cloud-account-settings-store', () => ({
  CloudAccountSettingsStore: {
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

  it('respects enabled model configuration when checking depletion', async () => {
    // eslint-disable-next-line unused-imports/no-unused-vars
    const { CloudAccountRepo } = await import('@/modules/cloud-account/persistence/cloudHandler');
    const { CloudAccountSettingsStore } =
      await import('@/modules/cloud-account/persistence/cloud-account-settings-store');
    const { AutoSwitchService } =
      await import('@/modules/cloud-account/services/AutoSwitchService');

    const config = {
      'claude-sonnet-4-5': { enabled: false, priority: false },
      'gemini-pro': { enabled: true, priority: false },
    };
    vi.mocked(CloudAccountSettingsStore.getSetting).mockReturnValue(config);

    const testAccount = createAccount('test-acc', {
      models: {
        'claude-sonnet-4-5': { percentage: 2, resetTime: '' },
        'gemini-pro': { percentage: 90, resetTime: '' },
      },
    });

    // Depleted should be false because claude-sonnet-4-5 is disabled!
    expect(AutoSwitchService.isAccountDepleted(testAccount)).toBe(false);
  });

  it('uses the best quota in an alias group and keeps the threshold comparison strict', async () => {
    const { AutoSwitchService } =
      await import('@/modules/cloud-account/services/AutoSwitchService');

    const accountWithHealthySibling = createAccount('healthy-sibling', {
      models: {
        'gemini-3.1-pro-low': { percentage: 0, resetTime: '' },
        'gemini-3.1-pro-high': { percentage: 80, resetTime: '' },
        'gemini-3.1-flash-image': { percentage: 5, resetTime: '' },
      },
    });
    const accountWithDepletedGroup = createAccount('depleted-group', {
      models: {
        'gemini-3.1-pro-low': { percentage: 0, resetTime: '' },
        'gemini-3.1-pro-high': { percentage: 4, resetTime: '' },
      },
    });

    expect({
      healthySibling: AutoSwitchService.isAccountDepleted(accountWithHealthySibling),
      depletedGroup: AutoSwitchService.isAccountDepleted(accountWithDepletedGroup),
    }).toEqual({
      healthySibling: false,
      depletedGroup: true,
    });
  });

  it('prioritizes priority models during best account selection', async () => {
    const { CloudAccountRepo } = await import('@/modules/cloud-account/persistence/cloudHandler');
    const { CloudAccountSettingsStore } =
      await import('@/modules/cloud-account/persistence/cloud-account-settings-store');
    const { AutoSwitchService } =
      await import('@/modules/cloud-account/services/AutoSwitchService');

    const config = {
      'claude-sonnet-4-5': { enabled: true, priority: true },
      'gemini-pro': { enabled: true, priority: false },
    };
    vi.mocked(CloudAccountSettingsStore.getSetting).mockReturnValue(config);

    vi.mocked(CloudAccountRepo.getAccounts).mockResolvedValue([
      createAccount('current', {
        models: {
          'claude-sonnet-4-5': { percentage: 50, resetTime: '' },
          'gemini-pro': { percentage: 90, resetTime: '' },
        },
      }),
      // Acc A has lower overall average (45% vs 75%) but HIGHER priority model percentage (80% vs 60%)
      createAccount('acc-a', {
        models: {
          'claude-sonnet-4-5': { percentage: 80, resetTime: '' },
          'gemini-pro': { percentage: 10, resetTime: '' },
        },
      }),
      createAccount('acc-b', {
        models: {
          'claude-sonnet-4-5': { percentage: 60, resetTime: '' },
          'gemini-pro': { percentage: 90, resetTime: '' },
        },
      }),
    ]);

    await expect(AutoSwitchService.findBestAccount('current')).resolves.toMatchObject({
      id: 'acc-a',
    });
  });

  it('falls back to the global active account when the target account id is stale', async () => {
    const { CloudAccountRepo } = await import('@/modules/cloud-account/persistence/cloudHandler');
    const { CloudAccountSettingsStore } =
      await import('@/modules/cloud-account/persistence/cloud-account-settings-store');
    const { switchCloudAccount } = await import('@/modules/cloud-account/ipc/handler');
    const { AutoSwitchService } =
      await import('@/modules/cloud-account/services/AutoSwitchService');

    vi.mocked(CloudAccountSettingsStore.getSetting).mockImplementation((key: string) => {
      if (key === 'auto_switch_enabled') return true;
      if (key === 'auto_switch_models') return {};
      return undefined;
    });
    vi.mocked(CloudAccountSettingsStore.getActiveAccountIdForTarget).mockReturnValue(
      'deleted-account',
    );
    vi.mocked(CloudAccountRepo.getAccounts).mockResolvedValue([
      createAccount(
        'global-active',
        {
          models: {
            'gemini-pro': { percentage: 1, resetTime: '' },
          },
        },
        { is_active: true },
      ),
      createAccount('healthy-next', {
        models: {
          'gemini-pro': { percentage: 90, resetTime: '' },
        },
      }),
    ]);

    await expect(AutoSwitchService.checkAndSwitchIfNeeded('classic')).resolves.toBe(true);
    expect(switchCloudAccount).toHaveBeenCalledWith('healthy-next', 'classic');
  });
});
