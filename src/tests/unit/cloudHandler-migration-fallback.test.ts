import { describe, expect, it, vi, beforeEach } from 'vitest';
import { CloudAccountRepo } from '@/modules/cloud-account/persistence/cloudHandler';
import { getCloudDb } from '@/modules/cloud-account/persistence/cloud-account-db';
import * as security from '@/shared/security/security';
import { AppError } from '@/shared/errors/appError';

vi.mock('@/modules/cloud-account/persistence/cloud-account-db');
vi.mock('@/shared/security/security');

const validToken = {
  access_token: 'valid_token',
  refresh_token: 'refresh_token',
  expires_in: 3600,
  expiry_timestamp: 4102444800,
  token_type: 'Bearer',
};

describe('CloudAccountRepo migration fallback', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('should skip unmigratable corrupted token accounts and return valid ones without throwing DATA_MIGRATION_FAILED', async () => {
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
        value: JSON.stringify(validToken),
        reencrypted: undefined,
      };
    });

    const accounts = await CloudAccountRepo.getAccounts();

    expect(accounts).toHaveLength(1);
    expect(accounts[0].id).toBe('acc-valid');
    expect(accounts[0].email).toBe('valid@example.com');
  });

  it('throws MASTER_KEY_UNAVAILABLE when every persisted token fails authentication', async () => {
    const mockAccount = {
      id: 'acc-locked',
      provider: 'google',
      email: 'locked@example.com',
      tokenJson: 'encrypted_locked_token',
      quotaJson: null,
      deviceProfileJson: null,
      deviceHistoryJson: null,
      createdAt: 1000,
      lastUsed: 2000,
      status: 'active',
      statusReason: null,
      isActive: 1,
      proxyUrl: null,
    };
    const mockOrm = {
      select: () => ({
        from: () => ({
          orderBy: () => ({ all: () => [mockAccount] }),
        }),
      }),
    };
    vi.mocked(getCloudDb).mockReturnValue({
      raw: { close: vi.fn() },
      orm: mockOrm,
    } as unknown as ReturnType<typeof getCloudDb>);
    vi.mocked(security.decryptWithMigration).mockRejectedValue(
      new AppError('DATA_MIGRATION_FAILED', 'Data migration failed', {
        messageKey: 'error.dataMigrationFailed',
        metadata: { hint: 'HINT_RELOGIN' },
      }),
    );

    await expect(CloudAccountRepo.getAccounts()).rejects.toMatchObject({
      code: 'MASTER_KEY_UNAVAILABLE',
      metadata: {
        reason: 'NO_MATCHING_KEY',
        storedAccountCount: 1,
      },
    });
  });

  it('should gracefully handle quota decryption failure with DATA_MIGRATION_FAILED in getAccounts', async () => {
    const mockAccounts = [
      {
        id: 'acc-quota-failed',
        provider: 'google',
        email: 'quota-failed@example.com',
        tokenJson: 'encrypted_valid_token',
        quotaJson: 'encrypted_corrupted_quota',
        deviceProfileJson: null,
        deviceHistoryJson: null,
        createdAt: 1000,
        lastUsed: 2000,
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
      if (text === 'encrypted_corrupted_quota') {
        throw new AppError('DATA_MIGRATION_FAILED', 'Data migration failed', {
          messageKey: 'error.dataMigrationFailed',
          metadata: { hint: 'HINT_RELOGIN' },
        });
      }
      return {
        value: JSON.stringify(validToken),
        reencrypted: undefined,
      };
    });

    const accounts = await CloudAccountRepo.getAccounts();

    expect(accounts).toHaveLength(1);
    expect(accounts[0].id).toBe('acc-quota-failed');
    expect(accounts[0].quota).toBeUndefined();
  });

  it('preserves an account when decrypted quota contains malformed JSON', async () => {
    const mockAccount = {
      id: 'acc-malformed-quota',
      provider: 'google',
      email: 'malformed-quota@example.com',
      tokenJson: 'encrypted_valid_token',
      quotaJson: 'encrypted_malformed_quota',
      deviceProfileJson: null,
      deviceHistoryJson: null,
      createdAt: 1000,
      lastUsed: 2000,
      status: 'active',
      statusReason: null,
      isActive: 1,
      proxyUrl: null,
    };
    const mockOrm = {
      select: () => ({
        from: () => ({
          orderBy: () => ({ all: () => [mockAccount] }),
        }),
      }),
    };
    vi.mocked(getCloudDb).mockReturnValue({
      raw: { close: vi.fn() },
      orm: mockOrm,
    } as unknown as ReturnType<typeof getCloudDb>);
    vi.mocked(security.decryptWithMigration).mockImplementation(async (text: string) => {
      return {
        value: text === 'encrypted_valid_token' ? JSON.stringify(validToken) : '{invalid-json',
      };
    });

    const result = await CloudAccountRepo.getAccounts();

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: 'acc-malformed-quota',
      quota: undefined,
      token: validToken,
    });
  });

  it('should preserve the decryption error when a persisted account token is unreadable', async () => {
    const mockAccount = {
      id: 'acc-token-fail',
      provider: 'google',
      email: 'token-fail@example.com',
      tokenJson: 'encrypted_corrupted_token',
      quotaJson: null,
      deviceProfileJson: null,
      deviceHistoryJson: null,
      createdAt: 1000,
      lastUsed: 2000,
      status: 'active',
      statusReason: null,
      isActive: 1,
      proxyUrl: null,
    };

    const mockOrm = {
      select: () => ({
        from: () => ({
          where: () => ({
            all: () => [mockAccount],
          }),
        }),
      }),
    };

    vi.mocked(getCloudDb).mockReturnValue({
      raw: { close: vi.fn() } as any,
      orm: mockOrm as any,
    });

    vi.mocked(security.decryptWithMigration).mockImplementation(async () => {
      throw new AppError('DATA_MIGRATION_FAILED', 'Data migration failed', {
        messageKey: 'error.dataMigrationFailed',
        metadata: { hint: 'HINT_RELOGIN' },
      });
    });

    await expect(CloudAccountRepo.getAccount('acc-token-fail')).rejects.toMatchObject({
      code: 'DATA_MIGRATION_FAILED',
    });
  });

  it('should return account with quota undefined from getAccount(id) when quota decryption fails with DATA_MIGRATION_FAILED', async () => {
    const mockAccount = {
      id: 'acc-quota-fail',
      provider: 'google',
      email: 'quota-fail@example.com',
      tokenJson: 'encrypted_valid_token',
      quotaJson: 'encrypted_corrupted_quota',
      deviceProfileJson: null,
      deviceHistoryJson: null,
      createdAt: 1000,
      lastUsed: 2000,
      status: 'active',
      statusReason: null,
      isActive: 1,
      proxyUrl: null,
    };

    const mockOrm = {
      select: () => ({
        from: () => ({
          where: () => ({
            all: () => [mockAccount],
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
      if (text === 'encrypted_corrupted_quota') {
        throw new AppError('DATA_MIGRATION_FAILED', 'Data migration failed', {
          messageKey: 'error.dataMigrationFailed',
          metadata: { hint: 'HINT_RELOGIN' },
        });
      }
      return {
        value: JSON.stringify(validToken),
        reencrypted: undefined,
      };
    });

    const result = await CloudAccountRepo.getAccount('acc-quota-fail');

    expect(result).toBeDefined();
    expect(result?.id).toBe('acc-quota-fail');
    expect(result?.quota).toBeUndefined();
  });

  it('should preserve token parsing errors for a persisted account', async () => {
    const mockAccount = {
      id: 'acc-invalid-json',
      provider: 'google',
      email: 'invalid-json@example.com',
      tokenJson: 'encrypted_malformed_json_token',
      quotaJson: null,
      deviceProfileJson: null,
      deviceHistoryJson: null,
      createdAt: 1000,
      lastUsed: 2000,
      status: 'active',
      statusReason: null,
      isActive: 1,
      proxyUrl: null,
    };

    const mockOrm = {
      select: () => ({
        from: () => ({
          where: () => ({
            all: () => [mockAccount],
          }),
        }),
      }),
    };

    vi.mocked(getCloudDb).mockReturnValue({
      raw: { close: vi.fn() } as any,
      orm: mockOrm as any,
    });

    vi.mocked(security.decryptWithMigration).mockResolvedValue({
      value: '{ invalid_json_content }',
      reencrypted: undefined,
    });

    await expect(CloudAccountRepo.getAccount('acc-invalid-json')).rejects.toThrow();
  });
});
