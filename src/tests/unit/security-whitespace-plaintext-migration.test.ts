import fs from 'fs/promises';
import { safeStorage } from 'electron';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => true),
    decryptString: vi.fn(),
    encryptString: vi.fn((value: string) => Buffer.from(value, 'utf8')),
  },
  app: {
    getPath: vi.fn(() => 'C:\\test'),
    getAppPath: vi.fn(() => 'C:\\test\\app.asar'),
  },
}));

vi.mock('fs/promises', () => ({
  default: {
    readFile: vi.fn(),
    writeFile: vi.fn(),
  },
}));

vi.mock('keytar', () => ({
  default: {
    findCredentials: vi.fn(async () => []),
    getPassword: vi.fn(async () => null),
    setPassword: vi.fn(async () => undefined),
  },
}));

const fsMock = vi.mocked(fs, { deep: true });
const safeStorageMock = vi.mocked(safeStorage, { deep: true });

describe('whitespace-prefixed plaintext account migration', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();

    safeStorageMock.isEncryptionAvailable.mockReturnValue(true);
    safeStorageMock.encryptString.mockImplementation((value: string) => Buffer.from(value, 'utf8'));
    fsMock.readFile.mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }));
    fsMock.writeFile.mockResolvedValue(undefined);
  });

  it('returns an encrypted replacement for JSON with leading whitespace', async () => {
    const security = await import('@/shared/security/security');
    await security.initializeMasterKey({ encryptedSamples: [], storedAccountCount: 0 });

    const plaintext = ' \n\t{"access_token":"legacy-token"}';
    const result = await security.decryptWithMigration(plaintext);

    expect(result.value).toBe(plaintext);
    expect(result.reencrypted).toMatch(/^agm_enc_v1:/);

    const migrated = await security.decryptWithMigration(result.reencrypted!);
    expect(migrated.value).toBe(plaintext);
    expect(migrated.reencrypted).toBeUndefined();
  });

  it('keeps canonical plaintext JSON on the existing startup migration path', async () => {
    const security = await import('@/shared/security/security');
    await security.initializeMasterKey({ encryptedSamples: [], storedAccountCount: 0 });

    const result = await security.decryptWithMigration('{"access_token":"legacy-token"}');

    expect(result.value).toBe('{"access_token":"legacy-token"}');
    expect(result.reencrypted).toBeUndefined();
  });
});
