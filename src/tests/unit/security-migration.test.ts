import crypto from 'crypto';
import fs from 'fs/promises';
import keytar from 'keytar';
import { safeStorage } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decryptWithMigration } from '../../shared/security/security';

const primaryHex = '11'.repeat(32);
const fallbackHex = '22'.repeat(32);
const childProcessMock = vi.hoisted(() => ({
  execFileSync: vi.fn(),
  spawnSync: vi.fn(),
}));
const keyringMock = vi.hoisted(() => ({
  deleteCredential: vi.fn(),
  setSecret: vi.fn(),
  withTarget: vi.fn(),
}));

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

vi.mock('child_process', () => ({
  default: childProcessMock,
  execFileSync: childProcessMock.execFileSync,
  spawnSync: childProcessMock.spawnSync,
}));

vi.mock('@napi-rs/keyring', () => ({
  Entry: {
    withTarget: keyringMock.withTarget,
  },
}));

const fsMock = vi.mocked(fs, { deep: true });
const keytarMock = vi.mocked(keytar, { deep: true });
const safeStorageMock = vi.mocked(safeStorage, { deep: true });
const originalPlatform = process.platform;

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
  childProcessMock.execFileSync.mockReset();
  childProcessMock.spawnSync.mockReset();
  keyringMock.deleteCredential.mockReset();
  keyringMock.setSecret.mockReset();
  keyringMock.withTarget.mockReset();
  keyringMock.withTarget.mockReturnValue({
    deleteCredential: keyringMock.deleteCredential,
    setSecret: keyringMock.setSecret,
  });
});

function setPlatform(platformName: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', {
    value: platformName,
    configurable: true,
  });
}

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

describe('writeAntigravityCredentialStoreToken', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    setPlatform(originalPlatform);
  });

  const token = {
    access_token: 'access-token',
    refresh_token: 'refresh-token',
    expiry_timestamp: 1_700_000_000,
  };

  it('writes go-keyring-base64 payload on macOS', async () => {
    setPlatform('darwin');

    const { writeAntigravityCredentialStoreToken } =
      await import('@/modules/cloud-account/persistence/antigravityCredentialStore');

    writeAntigravityCredentialStoreToken(token);

    expect(childProcessMock.execFileSync).toHaveBeenLastCalledWith(
      'security',
      expect.arrayContaining(['-w', expect.stringMatching(/^go-keyring-base64:/)]),
      { stdio: 'ignore' },
    );
  });

  it('writes raw JSON payload to Linux secret-tool', async () => {
    childProcessMock.spawnSync.mockReturnValue({ status: 0, stderr: '' });
    setPlatform('linux');

    const { writeAntigravityCredentialStoreToken } =
      await import('@/modules/cloud-account/persistence/antigravityCredentialStore');

    writeAntigravityCredentialStoreToken(token);

    const storeCall = childProcessMock.spawnSync.mock.calls.find(
      (call) => call[1] && call[1].includes('store'),
    );
    expect(storeCall).toBeDefined();
    const options = storeCall![2] as { input: string };
    expect(options).toBeDefined();
    expect(options.input).toContain('"access_token":"access-token"');
    expect(options.input).not.toContain('go-keyring-base64');
  });

  it('writes raw JSON payload to Windows gemini:antigravity credential', async () => {
    setPlatform('win32');

    const { writeAntigravityCredentialStoreToken } =
      await import('@/modules/cloud-account/persistence/antigravityCredentialStore');

    writeAntigravityCredentialStoreToken(token);

    const secret = keyringMock.setSecret.mock.calls[0]?.[0] as Buffer;
    expect(keyringMock.withTarget).toHaveBeenCalledWith(
      'gemini:antigravity',
      'gemini',
      'antigravity',
    );
    expect(keyringMock.deleteCredential).toHaveBeenCalledTimes(1);
    expect(secret.toString('utf-8')).toContain('"access_token":"access-token"');
    expect(secret.toString('utf-8')).not.toContain('go-keyring-base64');
  });

  it('writes Windows credential when no previous credential can be deleted', async () => {
    keyringMock.deleteCredential.mockImplementationOnce(() => {
      throw new Error('NoEntry');
    });
    setPlatform('win32');

    const { writeAntigravityCredentialStoreToken } =
      await import('@/modules/cloud-account/persistence/antigravityCredentialStore');

    writeAntigravityCredentialStoreToken(token);

    expect(keyringMock.setSecret).toHaveBeenCalledTimes(1);
  });
});
