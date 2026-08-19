import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CloudAccount } from '@/modules/cloud-account/types';

const showNotification = vi.fn();

vi.mock('electron', () => ({
  Notification: vi.fn().mockImplementation(() => ({
    show: showNotification,
  })),
}));

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
  },
}));

function createAccount(id: string, status: CloudAccount['status'], percentage: number): CloudAccount {
  return {
    id,
    provider: 'google',
    email: `${id}@example.com`,
    token: {
      access_token: `${id}-access`,
      refresh_token: `${id}-refresh`,
      expires_in: 3600,
      expiry_timestamp: 2_000_000_000,
      token_type: 'Bearer',
    },
    quota: {
      models: {
        'gemini-3.1-pro-high': {
          percentage,
          resetTime: '',
        },
      },
    },
    created_at: 1_700_000_000,
    last_used: 1_700_000_000,
    status,
  };
}

describe('AutoSwitchService expired current account recovery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('switches away from an expired current account even when quota is healthy', async () => {
    const { CloudAccountRepo } = await import('@/modules/cloud-account/persistence/cloudHandler');
    const { CloudAccountSettingsStore } =
      await import('@/modules/cloud-account/persistence/cloud-account-settings-store');
    const { switchCloudAccount } = await import('@/modules/cloud-account/ipc/handler');
    const { AutoSwitchService } =
      await import('@/modules/cloud-account/services/AutoSwitchService');

    const current = createAccount('expired-current', 'expired', 90);
    const healthy = createAccount('healthy-next', 'active', 80);

    vi.mocked(CloudAccountRepo.getAccounts).mockResolvedValue([current, healthy]);
    vi.mocked(CloudAccountSettingsStore.getSetting).mockImplementation((key, fallback) => {
      if (key === 'auto_switch_enabled') {
        return true as typeof fallback;
      }
      if (key === 'auto_switch_models') {
        return {} as typeof fallback;
      }
      return fallback;
    });
    vi.mocked(CloudAccountSettingsStore.getActiveAccountIdForTarget).mockReturnValue(current.id);

    await expect(AutoSwitchService.checkAndSwitchIfNeeded('classic')).resolves.toBe(true);
    expect(switchCloudAccount).toHaveBeenCalledTimes(1);
    expect(switchCloudAccount).toHaveBeenCalledWith(healthy.id, 'classic');
    expect(showNotification).toHaveBeenCalledTimes(1);
  });
});
