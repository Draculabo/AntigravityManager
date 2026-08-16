import crypto from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { MasterKeyManager, type MasterKeyProvider } from '@/shared/security/master-key-manager';

function encryptSample(key: Buffer, value: string): string {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);

  return `agm_enc_v1:${iv.toString('hex')}:${cipher.getAuthTag().toString('hex')}:${ciphertext.toString('hex')}`;
}

function safeStorageProvider(key: Buffer): MasterKeyProvider {
  return {
    source: 'safeStorage',
    read: vi.fn().mockResolvedValue({
      status: 'available',
      source: 'safeStorage',
      key,
    }),
  };
}

describe('MasterKeyManager partial recovery status', () => {
  it('reports degraded when some encrypted data is not covered by any available key', async () => {
    const availableKey = Buffer.alloc(32, 1);
    const missingKey = Buffer.alloc(32, 2);
    const manager = new MasterKeyManager({
      providers: [safeStorageProvider(availableKey)],
    });

    const resolved = await manager.initialize({
      encryptedSamples: [
        encryptSample(availableKey, '{"access_token":"available"}'),
        encryptSample(missingKey, '{"access_token":"unresolved"}'),
      ],
      storedAccountCount: 2,
    });

    expect(resolved.key).toEqual(availableKey);
    expect(manager.getSecurityStatus()).toEqual({
      state: 'degraded',
      masterKeySource: 'safeStorage',
    });
  });

  it('keeps secure status when the available key covers all encrypted data', async () => {
    const key = Buffer.alloc(32, 3);
    const manager = new MasterKeyManager({
      providers: [safeStorageProvider(key)],
    });

    await manager.initialize({
      encryptedSamples: [
        encryptSample(key, '{"access_token":"first"}'),
        encryptSample(key, '{"access_token":"second"}'),
      ],
      storedAccountCount: 2,
    });

    expect(manager.getSecurityStatus()).toEqual({
      state: 'secure',
      masterKeySource: 'safeStorage',
    });
  });
});
