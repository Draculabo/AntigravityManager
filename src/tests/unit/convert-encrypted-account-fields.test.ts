import { beforeEach, describe, expect, it, vi } from 'vitest';
import { convertEncryptedAccountFields } from '@/modules/cloud-account/persistence/convert-encrypted-account-fields';

const mocks = vi.hoisted(() => ({
  rows: [] as Array<{
    id: string;
    tokenJson: string;
    quotaJson: string | null;
    healthJson: string | null;
  }>,
  writes: [] as Array<{ id: string; values: object }>,
  backup: vi.fn(async () => {}),
  close: vi.fn(),
  initializeMasterKey: vi.fn(async () => {}),
  decryptWithMigration: vi.fn(async (value: string) => ({ value })),
  transaction: vi.fn(),
}));

vi.mock('@/shared/platform/paths', () => ({
  getCloudAccountsDbPath: () => 'test-accounts.db',
}));
vi.mock('@/shared/logging/logger', () => ({
  logger: { info: vi.fn() },
}));
vi.mock('@/shared/security/security', () => ({
  initializeMasterKey: mocks.initializeMasterKey,
  decryptWithMigration: mocks.decryptWithMigration,
}));
vi.mock('@/modules/cloud-account/persistence/cloud-account-db', () => ({
  getCloudDb: () => ({
    raw: { backup: mocks.backup, close: mocks.close },
    orm: {
      select: () => ({ from: () => ({ all: () => mocks.rows }) }),
      transaction: mocks.transaction,
    },
  }),
}));

const token = JSON.stringify({
  access_token: 'access',
  refresh_token: 'refresh',
  expires_in: 3600,
  expiry_timestamp: 4102444800,
  token_type: 'Bearer',
});
const ciphertext = 'agm_enc_v1:0011:2233:4455';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.rows = [];
  mocks.writes = [];
  mocks.transaction.mockImplementation((callback: (transaction: object) => void) => {
    callback({
      update: () => ({
        set: (values: object) => ({
          where: (_condition: object) => ({
            run: () => {
              mocks.writes.push({ id: mocks.rows[0].id, values });
            },
          }),
        }),
      }),
    });
  });
  mocks.decryptWithMigration.mockResolvedValue({ value: token });
});

describe('convertEncryptedAccountFields', () => {
  it('leaves plaintext accounts untouched without loading the master key', async () => {
    mocks.rows = [{ id: 'a', tokenJson: token, quotaJson: null, healthJson: null }];

    await convertEncryptedAccountFields();

    expect(mocks.initializeMasterKey).not.toHaveBeenCalled();
    expect(mocks.backup).not.toHaveBeenCalled();
    expect(mocks.writes).toEqual([]);
    expect(mocks.close).toHaveBeenCalledOnce();
  });

  it('backs up then atomically converts old ciphertext to validated JSON', async () => {
    const quota = JSON.stringify({ models: {} });
    const health = JSON.stringify({ oauth: { refresh_blocked: false } });
    const quotaCiphertext = 'agm_enc_v1:0011:2233:6677';
    const healthCiphertext = 'agm_enc_v1:0011:2233:8899';
    mocks.rows = [
      {
        id: 'a',
        tokenJson: ciphertext,
        quotaJson: quotaCiphertext,
        healthJson: healthCiphertext,
      },
    ];
    const decoded = new Map([
      [ciphertext, token],
      [quotaCiphertext, quota],
      [healthCiphertext, health],
    ]);
    mocks.decryptWithMigration.mockImplementation(async (value: string) => {
      const plaintext = decoded.get(value);
      if (!plaintext) {
        throw new Error('Unexpected ciphertext');
      }
      return { value: plaintext };
    });
    mocks.backup.mockImplementationOnce(async () => {
      expect(mocks.writes).toEqual([]);
    });

    await convertEncryptedAccountFields();

    expect(mocks.initializeMasterKey).toHaveBeenCalledOnce();
    expect(mocks.backup).toHaveBeenCalledOnce();
    expect(mocks.writes).toEqual([
      { id: 'a', values: { tokenJson: token, quotaJson: quota, healthJson: health } },
    ]);
    expect(mocks.close).toHaveBeenCalledOnce();
  });

  it('keeps stored ciphertext unchanged if the backup fails', async () => {
    mocks.rows = [{ id: 'a', tokenJson: ciphertext, quotaJson: null, healthJson: null }];
    mocks.backup.mockRejectedValueOnce(new Error('backup failed'));

    await expect(convertEncryptedAccountFields()).rejects.toThrow('backup failed');

    expect(mocks.writes).toEqual([]);
    expect(mocks.close).toHaveBeenCalledOnce();
  });

  it('keeps stored ciphertext unchanged if decrypted data is invalid', async () => {
    mocks.rows = [{ id: 'a', tokenJson: ciphertext, quotaJson: null, healthJson: null }];
    mocks.decryptWithMigration.mockResolvedValueOnce({ value: '{"access_token":"bad"}' });

    await expect(convertEncryptedAccountFields()).rejects.toThrow();

    expect(mocks.backup).not.toHaveBeenCalled();
    expect(mocks.writes).toEqual([]);
    expect(mocks.close).toHaveBeenCalledOnce();
  });
});
