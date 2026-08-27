import crypto from 'crypto';
import fs from 'fs/promises';
import keytar from 'keytar';
import { safeStorage } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  decryptWithMigration,
  encrypt,
  getSecurityStatus,
  initializeMasterKey,
} from '../../shared/security/security';

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
// The real writer targets the Antigravity CLI session file under the user's
// home, so leaving it unmocked signs the live CLI out mid-test-run.
const agyCliMock = vi.hoisted(() => ({ writeAgyCliToken: vi.fn() }));

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

vi.mock('@/modules/cloud-account/persistence/agyCliTokenStore', () => ({
  writeAgyCliToken: agyCliMock.writeAgyCliToken,
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

beforeEach(async () => {
  vi.clearAllMocks();

  safeStorageMock.isEncryptionAvailable.mockReturnValue(true);
  safeStorageMock.decryptString.mockReturnValue(primaryHex);

  fsMock.readFile.mockImplementation(async (filePath, encoding) => {
    const normalizedPath = String(filePath);
    if (normalizedPath.endsWith('master-key.v2.safe')) {
      return Buffer.from('encrypted');
    }
    if (normalizedPath.endsWith('master-key.v2.file')) {
      const missingError = new Error('missing') as NodeJS.ErrnoException;
      missingError.code = 'ENOENT';
      throw missingError;
    }
    if (normalizedPath.endsWith('.mk') && encoding !== 'utf8') {
      return Buffer.from('encrypted');
    }
    if (encoding === 'utf8') {
      return 'not-hex';
    }

    const missingError = new Error('missing') as NodeJS.ErrnoException;
    missingError.code = 'ENOENT';
    throw missingError;
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
  agyCliMock.writeAgyCliToken.mockReset();
  keyringMock.withTarget.mockReturnValue({
    deleteCredential: keyringMock.deleteCredential,
    setSecret: keyringMock.setSecret,
  });

  await initializeMasterKey({
    encryptedSamples: [
      encryptWithKey(Buffer.from(primaryHex, 'hex'), '{"token":"primary-sample"}'),
      encryptWithKey(Buffer.from(fallbackHex, 'hex'), '{"token":"fallback-sample"}'),
    ],
    storedAccountCount: 2,
  });
  expect(getSecurityStatus().masterKeySource).toBe('safeStorage');
});

function setPlatform(platformName: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', {
    value: platformName,
    configurable: true,
  });
}

describe('decryptWithMigration', () => {
  it('writes versioned ciphertext and decrypts it', async () => {
    const plaintext = '{"token":"versioned"}';
    const ciphertext = await encrypt(plaintext);

    expect(ciphertext).toMatch(/^agm_enc_v1:/);

    const result = await decryptWithMigration(ciphertext);

    expect(result.value).toBe(plaintext);
    expect(result.reencrypted).toBeUndefined();
  });

  it('decrypts legacy unprefixed ciphertext and returns a versioned replacement', async () => {
    const plaintext = '{"token":"legacy-primary"}';
    const ciphertext = encryptWithKey(Buffer.from(primaryHex, 'hex'), plaintext);

    const result = await decryptWithMigration(ciphertext);

    expect(result.value).toBe(plaintext);
    expect(result.reencrypted).toBe(`agm_enc_v1:${ciphertext}`);
  });

  it('migrates a recovered historical key payload to the primary DEK', async () => {
    const plaintext = '{"token":"legacy"}';
    const ciphertext = encryptWithKey(Buffer.from(fallbackHex, 'hex'), plaintext);

    const result = await decryptWithMigration(ciphertext);

    expect(result.value).toBe(plaintext);
    expect(result.usedFallback).toBe('keytar');
    expect(result.reencrypted).toMatch(/^agm_enc_v1:/);
    expect(result.reencrypted).not.toBe(`agm_enc_v1:${ciphertext}`);
    if (result.reencrypted) {
      const migrated = await decryptWithMigration(result.reencrypted);
      expect(migrated.value).toBe(plaintext);
      expect(migrated.usedFallback).toBeUndefined();
    }
  });

  it('does not use fallback when primary key works for legacy ciphertext', async () => {
    const plaintext = '{"token":"primary"}';
    const ciphertext = encryptWithKey(Buffer.from(primaryHex, 'hex'), plaintext);

    const result = await decryptWithMigration(ciphertext);

    expect(result.value).toBe(plaintext);
    expect(result.usedFallback).toBeUndefined();
    expect(result.reencrypted).toMatch(/^agm_enc_v1:/);
  });

  it('throws structured migration error when legacy keys are unavailable', async () => {
    keytarMock.getPassword.mockResolvedValue(null);
    fsMock.readFile.mockImplementation(async (_path, encoding) => {
      if (encoding === 'utf8') {
        return 'not-hex';
      }

      return Buffer.from('encrypted');
    });

    const plaintext = '{"token":"legacy"}';
    const ciphertext = encryptWithKey(Buffer.from('33'.repeat(32), 'hex'), plaintext);

    await expect(decryptWithMigration(ciphertext)).rejects.toMatchObject({
      code: 'DATA_MIGRATION_FAILED',
      messageKey: 'error.dataMigrationFailed',
      detailMessageKey: 'error.dataMigrationHint.relogin',
    });
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

  it('writes the macOS keychain payload through stdin', async () => {
    setPlatform('darwin');

    const { writeAntigravityCredentialStoreToken } =
      await import('@/modules/cloud-account/persistence/antigravityCredentialStore');

    writeAntigravityCredentialStoreToken(token);

    expect(childProcessMock.execFileSync).toHaveBeenLastCalledWith(
      'security',
      ['add-generic-password', '-s', 'gemini', '-a', 'antigravity', '-A', '-U', '-w'],
      expect.objectContaining({
        input: expect.stringMatching(/^go-keyring-base64:/),
        encoding: 'utf-8',
        stdio: ['pipe', 'ignore', 'ignore'],
      }),
    );
  });

  it('writes raw JSON payload to Linux secret-tool first', async () => {
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
    expect(options.input).toContain('"access_token":"access-token"');
    expect(options.input).not.toContain('go-keyring-base64');
    expect(keyringMock.setSecret).not.toHaveBeenCalled();
  });

  it('uses secret-tool when its no-argument usage probe exits non-zero', async () => {
    childProcessMock.spawnSync
      .mockReturnValueOnce({ error: undefined, status: 2, stderr: 'usage: secret-tool' })
      .mockReturnValueOnce({ error: undefined, status: 0, stderr: '' });
    setPlatform('linux');

    const { writeAntigravityCredentialStoreToken } =
      await import('@/modules/cloud-account/persistence/antigravityCredentialStore');

    writeAntigravityCredentialStoreToken(token);

    expect(childProcessMock.spawnSync).toHaveBeenNthCalledWith(1, 'secret-tool', [], {
      stdio: 'ignore',
      timeout: 3000,
    });
    expect(childProcessMock.spawnSync).toHaveBeenNthCalledWith(
      2,
      'secret-tool',
      ['store', '--label=gemini', 'service', 'gemini', 'username', 'antigravity'],
      expect.objectContaining({ input: expect.stringContaining('"access_token":"access-token"') }),
    );
    expect(keyringMock.setSecret).not.toHaveBeenCalled();
  });

  it('falls back to Linux keyring when secret-tool is unavailable', async () => {
    childProcessMock.spawnSync.mockReturnValue({
      status: null,
      error: new Error('ENOENT'),
      stderr: '',
    });
    setPlatform('linux');

    const { writeAntigravityCredentialStoreToken } =
      await import('@/modules/cloud-account/persistence/antigravityCredentialStore');

    writeAntigravityCredentialStoreToken(token);

    const secret = keyringMock.setSecret.mock.calls[0]?.[0] as Buffer;
    expect(keyringMock.withTarget).toHaveBeenCalledWith(
      'gemini:antigravity',
      'gemini',
      'antigravity',
    );
    expect(keyringMock.deleteCredential).not.toHaveBeenCalled();
    expect(secret.toString('utf-8')).toContain('"access_token":"access-token"');
    expect(secret.toString('utf-8')).not.toContain('go-keyring-base64');
  });

  it('falls back to Linux keyring when secret-tool store fails', async () => {
    childProcessMock.spawnSync
      .mockReturnValueOnce({ status: 0, stderr: '' })
      .mockReturnValueOnce({ status: 1, stderr: 'store failed' });
    setPlatform('linux');

    const { writeAntigravityCredentialStoreToken } =
      await import('@/modules/cloud-account/persistence/antigravityCredentialStore');

    writeAntigravityCredentialStoreToken(token);

    expect(keyringMock.setSecret).toHaveBeenCalledTimes(1);
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
    expect(keyringMock.deleteCredential).not.toHaveBeenCalled();
    expect(secret.toString('utf-8')).toContain('"access_token":"access-token"');
    expect(secret.toString('utf-8')).not.toContain('go-keyring-base64');
  });

  it('updates Windows credentials without deleting the existing entry first', async () => {
    setPlatform('win32');

    const { writeAntigravityCredentialStoreToken } =
      await import('@/modules/cloud-account/persistence/antigravityCredentialStore');

    writeAntigravityCredentialStoreToken(token);

    expect(keyringMock.setSecret).toHaveBeenCalledTimes(1);
    expect(keyringMock.deleteCredential).not.toHaveBeenCalled();
  });

  it('hands the credential store payload to the Antigravity CLI unchanged', async () => {
    setPlatform('win32');

    const { writeAntigravityCredentialStoreToken } =
      await import('@/modules/cloud-account/persistence/antigravityCredentialStore');

    writeAntigravityCredentialStoreToken(token);

    const secret = keyringMock.setSecret.mock.calls[0]?.[0] as Buffer;
    expect(agyCliMock.writeAgyCliToken).toHaveBeenCalledWith(secret.toString('utf-8'));
  });
});
