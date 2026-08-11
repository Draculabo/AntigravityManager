import { describe, expect, it, vi, beforeEach } from 'vitest';
import { CloudAccountRepo } from '@/modules/cloud-account/persistence/cloudHandler';
import { getCloudDb } from '@/modules/cloud-account/persistence/cloud-account-db';
import * as security from '@/shared/security/security';
import { AppError } from '@/shared/errors/appError';

vi.mock('@/modules/cloud-account/persistence/cloud-account-db');
vi.mock('@/shared/security/security');

describe('CloudAccountRepo migration fallback', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('should skip unmigratable corrupted accounts and return valid ones without throwing DATA_MIGRATION_FAILED', async () => {
    const mockAccounts = [
      {
        id: 'acc-corrupted',
        provider: 'google',
        email: 'corrupted@example.com',
        tokenJson: 'encrypted_corrupted_token',
        quotaJson: null,
        deviceProfileJson: null,
        deviceHistoryJson: null,
        createdAt: 1000,
        lastUsed: 2000,
        status: 'active',
        statusReason: null,
        isActive: 0,
        proxyUrl: null,
      },
      {
        id: 'acc-valid',
        provider: 'google',
        email: 'valid@example.com',
        tokenJson: 'encrypted_valid_token',
        quotaJson: null,
        deviceProfileJson: null,
        deviceHistoryJson: null,
        createdAt: 1000,
        lastUsed: 2100,
        status: 'active',
        statusReason: null,
        isActive: 1,
        proxyUrl: null,
      },
    ];

    const mockOrm = {
      select: () => ({
        from: () => ({
          orderBy: () => ({
            all: () => mockAccounts,
          }),
        }),
      }),
      update: () => ({
        set: () => ({
          where: () => ({
            run: vi.fn(),
          }),
        }),
      }),
    };

    vi.mocked(getCloudDb).mockReturnValue({
      raw: { close: vi.fn() } as any,
      orm: mockOrm as any,
    });

    vi.mocked(security.decryptWithMigration).mockImplementation(async (text: string) => {
      if (text === 'encrypted_corrupted_token') {
        throw new AppError('DATA_MIGRATION_FAILED', 'Data migration failed', {
          messageKey: 'error.dataMigrationFailed',
          metadata: { hint: 'HINT_RELOGIN' },
        });
      }
      return {
        value: JSON.stringify({ access_token: 'valid_token' }),
        reencrypted: undefined,
      };
    });

    const accounts = await CloudAccountRepo.getAccounts();

    expect(accounts).toHaveLength(1);
    expect(accounts[0].id).toBe('acc-valid');
    expect(accounts[0].email).toBe('valid@example.com');
  });
});
