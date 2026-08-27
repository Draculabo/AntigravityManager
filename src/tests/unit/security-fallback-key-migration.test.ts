import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  decryptParsedPayloadWithKey,
  encryptWithKey,
  parseEncryptedPayload,
} from '@/shared/security/crypto';

const electronState = vi.hoisted(() => ({
  userDataPath: '',
}));

vi.mock('electron', () => ({
  app: {
    getAppPath: () => electronState.userDataPath,
    getPath: () => electronState.userDataPath,
  },
  safeStorage: {
    decryptString: (value: Buffer) => value.toString('utf8'),
    encryptString: (value: string) => Buffer.from(value, 'utf8'),
    isEncryptionAvailable: () => true,
  },
}));

vi.mock('keytar', () => ({
  default: {
    findCredentials: vi.fn().mockResolvedValue([]),
    getPassword: vi.fn().mockResolvedValue(null),
    setPassword: vi.fn().mockResolvedValue(undefined),
  },
}));

describe('fallback master-key migration', () => {
  let tempDir: string;

  beforeEach(async () => {
    vi.resetModules();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agm-key-migration-'));
    electronState.userDataPath = tempDir;
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('re-encrypts versioned fallback payloads with the primary key', async () => {
    const primaryKey = Buffer.alloc(32, 0x11);
    const fallbackKey = Buffer.alloc(32, 0x22);
    const primaryPayload = encryptWithKey(primaryKey, JSON.stringify({ account: 'primary' }));
    const fallbackPayload = encryptWithKey(fallbackKey, JSON.stringify({ account: 'fallback' }));

    await fs.writeFile(path.join(tempDir, 'master-key.v2.safe'), primaryKey.toString('hex'));
    await fs.writeFile(path.join(tempDir, 'master-key.v2.file'), fallbackKey.toString('hex'));

    const security = await import('@/shared/security/security');
    await security.initializeMasterKey({
      encryptedSamples: [primaryPayload, fallbackPayload],
      storedAccountCount: 2,
    });

    const result = await security.decryptWithMigration(fallbackPayload);

    expect(result.value).toBe(JSON.stringify({ account: 'fallback' }));
    expect(result.usedFallback).toBe('file');
    expect(result.reencrypted).toBeDefined();
    expect(result.reencrypted).not.toBe(fallbackPayload);

    const migratedPayload = parseEncryptedPayload(result.reencrypted!);
    expect(migratedPayload).not.toBeNull();
    expect(decryptParsedPayloadWithKey(primaryKey, migratedPayload!)).toBe(result.value);
    expect(() => decryptParsedPayloadWithKey(fallbackKey, migratedPayload!)).toThrow();
  });

  it('does not rewrite an already versioned payload encrypted by the primary key', async () => {
    const primaryKey = Buffer.alloc(32, 0x33);
    const primaryPayload = encryptWithKey(primaryKey, JSON.stringify({ account: 'primary' }));

    await fs.writeFile(path.join(tempDir, 'master-key.v2.safe'), primaryKey.toString('hex'));

    const security = await import('@/shared/security/security');
    await security.initializeMasterKey({
      encryptedSamples: [primaryPayload],
      storedAccountCount: 1,
    });

    const result = await security.decryptWithMigration(primaryPayload);

    expect(result.usedFallback).toBeUndefined();
    expect(result.reencrypted).toBeUndefined();
  });
});
