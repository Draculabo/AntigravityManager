import crypto from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { getAppErrorData } from '@/shared/errors/appError';
import { MasterKeyManager, type MasterKeyProvider } from '@/shared/security/master-key-manager';

function encryptSample(key: Buffer, value: string): string {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);

  return `agm_enc_v1:${iv.toString('hex')}:${cipher.getAuthTag().toString('hex')}:${ciphertext.toString('hex')}`;
}

describe('MasterKeyManager', () => {
  it('does not generate or persist a new key when existing encrypted data cannot be decrypted', async () => {
    const encryptedSample = encryptSample(Buffer.alloc(32, 1), '{"access_token":"token"}');
    const write = vi.fn<NonNullable<MasterKeyProvider['write']>>();
    const provider: MasterKeyProvider = {
      source: 'safeStorage',
      read: vi.fn().mockResolvedValue({
        status: 'available',
        source: 'safeStorage',
        key: Buffer.alloc(32, 2),
      }),
      write,
    };
    const generateKey = vi.fn(() => Buffer.alloc(32, 3));
    const manager = new MasterKeyManager({ providers: [provider], generateKey });

    let failure: unknown;
    try {
      await manager.initialize({ encryptedSamples: [encryptedSample] });
    } catch (error) {
      failure = error;
    }

    expect(getAppErrorData(failure)?.appErrorCode).toBe('MASTER_KEY_UNAVAILABLE');
    expect(generateKey).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    expect(manager.getSecurityStatus().state).toBe('locked');
  });

  it('retains every existing key that authenticates stored ciphertext', async () => {
    const firstKey = Buffer.alloc(32, 4);
    const secondKey = Buffer.alloc(32, 5);
    const providers: MasterKeyProvider[] = [
      {
        source: 'safeStorage',
        read: vi.fn().mockResolvedValue({
          status: 'available',
          source: 'safeStorage',
          key: firstKey,
        }),
      },
      {
        source: 'legacy-keytar',
        read: vi.fn().mockResolvedValue({
          status: 'available',
          source: 'legacy-keytar',
          key: secondKey,
        }),
      },
    ];
    const manager = new MasterKeyManager({ providers });

    await manager.initialize({
      encryptedSamples: [
        encryptSample(firstKey, '{"access_token":"first"}'),
        encryptSample(secondKey, '{"access_token":"second"}'),
      ],
    });

    expect(manager.getDecryptionKeys()).toEqual([
      { key: firstKey, source: 'safeStorage' },
      { key: secondKey, source: 'legacy-keytar' },
    ]);
    expect(manager.getSecurityStatus().state).toBe('degraded');
  });

  it('copies a recovered legacy key into a missing preferred V2 slot without changing the DEK', async () => {
    const recoveredKey = Buffer.alloc(32, 6);
    const writePreferred = vi.fn(async () => undefined);
    const providers: MasterKeyProvider[] = [
      {
        source: 'safeStorage',
        read: vi.fn().mockResolvedValue({ status: 'missing', source: 'safeStorage' }),
        write: writePreferred,
      },
      {
        source: 'legacy-file',
        read: vi.fn().mockResolvedValue({
          status: 'available',
          source: 'legacy-file',
          key: recoveredKey,
        }),
      },
    ];
    const generateKey = vi.fn(() => Buffer.alloc(32, 7));
    const manager = new MasterKeyManager({ providers, generateKey });

    await manager.initialize({
      encryptedSamples: [encryptSample(recoveredKey, '{"access_token":"legacy"}')],
    });

    expect(writePreferred).toHaveBeenCalledWith(recoveredKey);
    expect(generateKey).not.toHaveBeenCalled();
    expect(manager.getDecryptionKeys()[0].key).toEqual(recoveredKey);
    expect(manager.getSecurityStatus()).toEqual({
      state: 'secure',
      masterKeySource: 'safeStorage',
    });
  });

  it('creates a new key only when every key slot is missing', async () => {
    const generateKey = vi.fn(() => Buffer.alloc(32, 8));
    const manager = new MasterKeyManager({
      providers: [
        {
          source: 'safeStorage',
          read: vi.fn().mockResolvedValue({
            status: 'unavailable',
            source: 'safeStorage',
            error: new Error('permission denied'),
          }),
          write: vi.fn(),
        },
      ],
      generateKey,
    });

    await expect(manager.initialize({ encryptedSamples: [] })).rejects.toMatchObject({
      code: 'MASTER_KEY_UNAVAILABLE',
    });
    expect(generateKey).not.toHaveBeenCalled();
  });

  it('uses compatibility storage for a fresh database when native keytar is unavailable', async () => {
    const generatedKey = Buffer.alloc(32, 9);
    const writeCompatibilityKey = vi.fn(async () => undefined);
    const manager = new MasterKeyManager({
      providers: [
        {
          source: 'safeStorage',
          read: vi.fn().mockResolvedValue({ status: 'missing', source: 'safeStorage' }),
          write: vi.fn(async () => {
            throw new Error('safeStorage unavailable');
          }),
        },
        {
          source: 'keytar',
          read: vi.fn().mockResolvedValue({
            status: 'unavailable',
            source: 'keytar',
            error: new Error('native module unavailable'),
          }),
          write: vi.fn(async () => {
            throw new Error('keytar unavailable');
          }),
        },
        {
          source: 'file',
          read: vi.fn().mockResolvedValue({ status: 'missing', source: 'file' }),
          write: writeCompatibilityKey,
        },
      ],
      generateKey: () => generatedKey,
    });

    const resolved = await manager.initialize({ encryptedSamples: [], storedAccountCount: 0 });

    expect(writeCompatibilityKey).toHaveBeenCalledWith(generatedKey);
    expect(resolved).toEqual({ key: generatedKey, source: 'file' });
    expect(manager.getSecurityStatus().state).toBe('degraded');
  });
});
