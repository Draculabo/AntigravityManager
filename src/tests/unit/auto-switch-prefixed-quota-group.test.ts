import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CloudAccount } from '@/modules/cloud-account/types';

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

function createAccount(): CloudAccount {
  return {
    id: 'prefixed-model-account',
    provider: 'google',
    email: 'prefixed-model-account@example.com',
    token: {
      access_token: 'access-token',
      refresh_token: 'refresh-token',
      expires_in: 3600,
      expiry_timestamp: 1700000000,
      token_type: 'Bearer',
    },
    quota: {
      models: {
        'models/gemini-3-pro-high': {
          percentage: 90,
          resetTime: '',
        },
      },
      quota_groups: [
        {
          display_name: 'Gemini 3 Pro models',
          buckets: [
            {
              bucket_id: '5h',
              window: '5h',
              remaining_fraction: 0.01,
              reset_time: '',
            },
          ],
        },
      ],
    },
    created_at: 1700000000,
    last_used: 1700000000,
    status: 'active',
  };
}

describe('AutoSwitchService prefixed quota group matching', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('treats a depleted quota group as affected when model ids use the models/ prefix', async () => {
    const { AutoSwitchService } =
      await import('@/modules/cloud-account/services/AutoSwitchService');

    expect(AutoSwitchService.isAccountDepleted(createAccount())).toBe(true);
  });
});
