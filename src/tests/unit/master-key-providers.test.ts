import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LegacySafeStorageProvider } from '@/shared/security/key-providers/safe-storage-provider';
import { FileMasterKeyProvider } from '@/shared/security/key-providers/file-provider';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => {
      return fs.rm(directory, { recursive: true, force: true });
    }),
  );
});

describe('legacy master-key providers', () => {
  it('leaves an existing legacy safeStorage file unchanged when safeStorage is unavailable', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agm-master-key-'));
    temporaryDirectories.push(directory);
    const legacyPath = path.join(directory, '.mk');
    const original = Buffer.from([0, 255, 12, 42, 99, 1, 7]);
    await fs.writeFile(legacyPath, original);
    const provider = new LegacySafeStorageProvider(legacyPath, {
      isEncryptionAvailable: () => false,
      encryptString: () => {
        throw new Error('not available');
      },
      decryptString: () => {
        throw new Error('not available');
      },
    });

    const result = await provider.read();
    const after = await fs.readFile(legacyPath);

    expect(result.status).toBe('unavailable');
    expect(after.equals(original)).toBe(true);
  });

  it('never overwrites a conflicting V2 compatibility key', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agm-master-key-'));
    temporaryDirectories.push(directory);
    const keyPath = path.join(directory, 'master-key.v2.file');
    const original = '11'.repeat(32);
    await fs.writeFile(keyPath, original, 'utf8');
    const provider = new FileMasterKeyProvider(keyPath);

    await expect(provider.write(Buffer.from('22'.repeat(32), 'hex'))).rejects.toThrow(
      'different master key',
    );

    expect(await fs.readFile(keyPath, 'utf8')).toBe(original);
  });

  it('reports a safeStorage slot read permission error as unavailable', async () => {
    const permissionError = Object.assign(new Error('permission denied'), { code: 'EACCES' });
    const readFileSpy = vi.spyOn(fs, 'readFile').mockRejectedValueOnce(permissionError);
    const provider = new LegacySafeStorageProvider('unreadable.mk', {
      isEncryptionAvailable: () => true,
      encryptString: () => Buffer.alloc(0),
      decryptString: () => '11'.repeat(32),
    });

    await expect(provider.read()).resolves.toEqual({
      status: 'unavailable',
      source: 'legacy-safeStorage',
      error: permissionError,
    });

    readFileSpy.mockRestore();
  });
});
