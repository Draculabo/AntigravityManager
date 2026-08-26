import { afterEach, describe, expect, it, vi } from 'vitest';
import { CloudAccountSettingsStore } from '@/modules/cloud-account/persistence/cloud-account-settings-store';

vi.mock('@/shared/logging/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

describe('CloudAccountSettingsStore.getActiveAccountIdForTarget', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns a normalized active account id when the setting is a string', () => {
    vi.spyOn(CloudAccountSettingsStore, 'getSetting').mockReturnValue('  account-1  ');

    expect(CloudAccountSettingsStore.getActiveAccountIdForTarget('classic')).toBe('account-1');
  });

  it('fails closed when a valid JSON setting has the wrong type', async () => {
    const getSetting = vi
      .spyOn(CloudAccountSettingsStore, 'getSetting')
      .mockReturnValue({ id: 'account-1' });
    const { logger } = await import('@/shared/logging/logger');

    expect(CloudAccountSettingsStore.getActiveAccountIdForTarget('ide')).toBe('');
    expect(getSetting).toHaveBeenCalledWith('active_cloud_account.ide', '');
    expect(logger.warn).toHaveBeenCalledWith(
      'Ignored invalid active account setting active_cloud_account.ide: expected a string',
    );
  });
});
