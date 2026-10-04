import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { encryptWithKey } from '@/shared/security/crypto';
import { FileMasterKeyProvider } from '@/shared/security/key-providers/file-provider';

const keyring = vi.hoisted(() => ({
  password: null as string | null,
  available: true,
  writes: 0,
}));

vi.mock('electron', () => {
  throw new Error('The Node security runtime must not load Electron');
});

vi.mock('keytar', () => ({
  default: {
    findCredentials: vi.fn(async () => {
      if (!keyring.available) {
        throw new Error('keyring unavailable');
      }
      return [];
    }),
    getPassword: vi.fn(async () => {
      if (!keyring.available) {
        throw new Error('keyring unavailable');
      }
      return keyring.password;
    }),
    setPassword: vi.fn(async (_service: string, _account: string, password: string) => {
      if (!keyring.available) {
        throw new Error('keyring unavailable');
      }
      keyring.password = password;
      keyring.writes += 1;
    }),
  },
}));

beforeEach(() => {
  vi.resetModules();
  keyring.password = null;
  keyring.available = true;
  keyring.writes = 0;
});

describe('standalone security runtime', () => {
  it('initializes and reads a master key using only the OS keyring', async () => {
    const security = await import('@/shared/security/security');
    const status = await security.initializeMasterKey({ encryptedSamples: [] });

    expect(status).toEqual({ state: 'secure', masterKeySource: 'keytar' });
    expect(keyring.password).toMatch(/^[a-f0-9]{64}$/);
    expect(keyring.writes).toBe(1);
    await security.ensureHeadlessMasterKeyAvailable();
    expect(keyring.writes).toBe(1);
  });

  it('fails closed when the OS keyring is unavailable', async () => {
    keyring.available = false;
    const security = await import('@/shared/security/security');

    await expect(security.initializeMasterKey({ encryptedSamples: [] })).rejects.toMatchObject({
      code: 'MASTER_KEY_UNAVAILABLE',
    });
    expect(security.getSecurityStatus().state).toBe('locked');
    expect(keyring.writes).toBe(0);
  });

  it('does not replace a lost key when encrypted account data exists', async () => {
    const security = await import('@/shared/security/security');
    const sample = encryptWithKey(Buffer.alloc(32, 0x42), '{"token":"existing"}');

    await expect(
      security.initializeMasterKey({ encryptedSamples: [sample], storedAccountCount: 1 }),
    ).rejects.toMatchObject({ code: 'MASTER_KEY_UNAVAILABLE' });
    expect(keyring.writes).toBe(0);
  });

  it('copies the resolved desktop key only into an empty keyring slot', async () => {
    const security = await import('@/shared/security/security');
    const desktopKey = Buffer.alloc(32, 0x11);
    security.configureSecurityRuntime({
      recoveryHint: 'HINT_RECOVERY',
      providers: [
        {
          source: 'safeStorage',
          read: async () => ({ status: 'available', source: 'safeStorage', key: desktopKey }),
        },
      ],
    });
    await security.initializeMasterKey({
      encryptedSamples: [encryptWithKey(desktopKey, '{"token":"desktop"}')],
    });

    await security.ensureHeadlessMasterKeyAvailable();
    expect(keyring.password).toBe(desktopKey.toString('hex'));
    expect(keyring.writes).toBe(1);

    vi.resetModules();
    const nodeSecurity = await import('@/shared/security/security');
    const status = await nodeSecurity.initializeMasterKey({
      encryptedSamples: [encryptWithKey(desktopKey, '{"token":"desktop"}')],
    });
    expect(status).toEqual({ state: 'secure', masterKeySource: 'keytar' });
    const ciphertext = await nodeSecurity.encrypt('headless-readable');
    expect(await nodeSecurity.decrypt(ciphertext)).toBe('headless-readable');
  });

  it('does not copy the desktop key when the OS keyring is unavailable', async () => {
    const security = await import('@/shared/security/security');
    const desktopKey = Buffer.alloc(32, 0x11);
    security.configureSecurityRuntime({
      recoveryHint: 'HINT_RECOVERY',
      providers: [
        {
          source: 'safeStorage',
          read: async () => ({ status: 'available', source: 'safeStorage', key: desktopKey }),
        },
      ],
    });
    await security.initializeMasterKey({
      encryptedSamples: [encryptWithKey(desktopKey, '{"token":"desktop"}')],
    });
    keyring.available = false;

    await expect(security.ensureHeadlessMasterKeyAvailable()).rejects.toMatchObject({
      code: 'MASTER_KEY_UNAVAILABLE',
    });
    expect(keyring.writes).toBe(0);
  });

  it('never overwrites a different key already stored in the keyring', async () => {
    const security = await import('@/shared/security/security');
    const desktopKey = Buffer.alloc(32, 0x11);
    const existingKey = Buffer.alloc(32, 0x22).toString('hex');
    security.configureSecurityRuntime({
      recoveryHint: 'HINT_RECOVERY',
      providers: [
        {
          source: 'safeStorage',
          read: async () => ({ status: 'available', source: 'safeStorage', key: desktopKey }),
        },
      ],
    });
    await security.initializeMasterKey({
      encryptedSamples: [encryptWithKey(desktopKey, '{"token":"desktop"}')],
    });
    keyring.password = existingKey;

    await expect(security.ensureHeadlessMasterKeyAvailable()).rejects.toMatchObject({
      code: 'MASTER_KEY_UNAVAILABLE',
    });
    expect(keyring.password).toBe(existingKey);
    expect(keyring.writes).toBe(0);
  });

  it('copies a matching legacy file key without changing its file', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agm-headless-key-'));
    try {
      const filePath = path.join(directory, 'master-key.v2.file');
      const legacyKey = Buffer.alloc(32, 0x33);
      await fs.writeFile(filePath, legacyKey.toString('hex'));
      const security = await import('@/shared/security/security');
      security.configureSecurityRuntime({
        recoveryHint: 'HINT_RECOVERY',
        providers: [new FileMasterKeyProvider(filePath)],
      });
      await security.initializeMasterKey({
        encryptedSamples: [encryptWithKey(legacyKey, '{"token":"legacy"}')],
      });

      await security.ensureHeadlessMasterKeyAvailable();

      expect(keyring.password).toBe(legacyKey.toString('hex'));
      expect(await fs.readFile(filePath, 'utf8')).toBe(legacyKey.toString('hex'));
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
});
