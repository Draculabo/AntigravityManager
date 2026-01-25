import crypto from 'crypto';
import fs from 'fs/promises';
import keytar from 'keytar';
import { safeStorage } from 'electron';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { decryptWithMigration } from '../../utils/security';

const primaryHex = '11'.repeat(32);
const fallbackHex = '22'.repeat(32);

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => true),
    decryptString: vi.fn(() => primaryHex),
    encryptString: vi.fn((value: string) => Buffer.from(value)),
  },
  app: {
    getPath: vi.fn(() => 'C:\\test'),
  },
}));

vi.mock('fs/promises', () => ({
  default: {
    readFile: vi.fn(),
    writeFile: vi.fn(),
    rename: vi.fn(),
    unlink: vi.fn(),
  },
}));

vi.mock('keytar', () => ({
  default: {
    findCredentials: vi.fn(async () => []),
    getPassword: vi.fn(async () => fallbackHex),
    setPassword: vi.fn(),
  },
}));

const fsMock = vi.mocked(fs, { deep: true });
const keytarMock = vi.mocked(keytar, { deep: true });
const safeStorageMock = vi.mocked(safeStorage, { deep: true });

function encryptWithKey(key: Buffer, text: string): string {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');

  const authTag = cipher.getAuthTag();

  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
}

beforeEach(() => {
  vi.clearAllMocks();

  safeStorageMock.isEncryptionAvailable.mockReturnValue(true);
  safeStorageMock.decryptString.mockReturnValue(primaryHex);

  fsMock.readFile.mockImplementation(async (_path, encoding) => {
    if (encoding === 'utf8') {
      return 'not-hex';
    }

    return Buffer.from('encrypted');
  });
  fsMock.writeFile.mockResolvedValue(undefined);
  fsMock.rename.mockResolvedValue(undefined);
  fsMock.unlink.mockResolvedValue(undefined);

  keytarMock.findCredentials.mockResolvedValue([]);
  keytarMock.getPassword.mockResolvedValue(fallbackHex);
});

describe('decryptWithMigration', () => {
  it('falls back to legacy key and re-encrypts', async () => {
    const plaintext = '{"token":"legacy"}';
    const ciphertext = encryptWithKey(Buffer.from(fallbackHex, 'hex'), plaintext);

    const result = await decryptWithMigration(ciphertext);

    expect(result.value).toBe(plaintext);
    expect(result.usedFallback).toBe('keytar');
    expect(result.reencrypted).toBeTypeOf('string');
    expect(result.reencrypted).not.toBe(ciphertext);
    expect(keytarMock.getPassword).toHaveBeenCalledTimes(1);

    if (result.reencrypted) {
      const migrated = await decryptWithMigration(result.reencrypted);
      expect(migrated.value).toBe(plaintext);
      expect(migrated.usedFallback).toBeUndefined();
    }
  });

  it('does not use fallback when primary key works', async () => {
    const plaintext = '{"token":"primary"}';
    const ciphertext = encryptWithKey(Buffer.from(primaryHex, 'hex'), plaintext);

    const result = await decryptWithMigration(ciphertext);

    expect(result.value).toBe(plaintext);
    expect(result.usedFallback).toBeUndefined();
    expect(result.reencrypted).toBeUndefined();
  });

  it('throws migration error code when legacy keys are unavailable', async () => {
    keytarMock.getPassword.mockResolvedValue(null);
    fsMock.readFile.mockImplementation(async (_path, encoding) => {
      if (encoding === 'utf8') {
        return 'not-hex';
      }

      return Buffer.from('encrypted');
    });

    const plaintext = '{"token":"legacy"}';
    const ciphertext = encryptWithKey(Buffer.from('33'.repeat(32), 'hex'), plaintext);

    await expect(decryptWithMigration(ciphertext)).rejects.toThrow('ERR_DATA_MIGRATION_FAILED');
  });
});
