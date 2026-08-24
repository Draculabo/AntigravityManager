import fs from 'fs/promises';
import type { KeyReadResult, MasterKeyProvider } from '@/shared/security/master-key-manager';

const MASTER_KEY_HEX_PATTERN = /^[a-f0-9]{64}$/i;

export interface SafeStorageAdapter {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}

function isMissingFileError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function isExistingFileError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'EEXIST';
}

async function readKeyFile(filePath: string): Promise<Buffer | null> {
  try {
    return await fs.readFile(filePath);
  } catch (error) {
    if (isMissingFileError(error)) {
      return null;
    }

    throw error;
  }
}

export class SafeStorageMasterKeyProvider implements MasterKeyProvider {
  readonly source = 'safeStorage' as const;

  constructor(
    private readonly filePath: string,
    private readonly safeStorage: SafeStorageAdapter,
  ) {}

  async read(): Promise<KeyReadResult> {
    let encryptedKey: Buffer | null;
    try {
      encryptedKey = await readKeyFile(this.filePath);
    } catch (error) {
      return { status: 'unavailable', source: this.source, error };
    }

    if (!encryptedKey) {
      return { status: 'missing', source: this.source };
    }
    if (!this.safeStorage.isEncryptionAvailable()) {
      return {
        status: 'unavailable',
        source: this.source,
        error: new Error('safeStorage is unavailable'),
      };
    }

    try {
      const decryptedKey = this.safeStorage.decryptString(encryptedKey);
      if (!MASTER_KEY_HEX_PATTERN.test(decryptedKey)) {
        return {
          status: 'corrupt',
          source: this.source,
          error: new Error('V2 safeStorage key has an invalid format'),
        };
      }

      return { status: 'available', source: this.source, key: Buffer.from(decryptedKey, 'hex') };
    } catch (error) {
      return { status: 'unavailable', source: this.source, error };
    }
  }

  async write(key: Buffer): Promise<void> {
    const existing = await this.read();
    if (existing.status === 'available') {
      if (existing.key.equals(key)) {
        return;
      }

      throw new Error('V2 safeStorage slot contains a different master key');
    }
    if (existing.status !== 'missing') {
      throw new Error('V2 safeStorage slot is not writable', { cause: existing.error });
    }
    if (!this.safeStorage.isEncryptionAvailable()) {
      throw new Error('safeStorage is unavailable');
    }

    const encryptedKey = this.safeStorage.encryptString(key.toString('hex'));
    try {
      await fs.writeFile(this.filePath, encryptedKey, { mode: 0o600, flag: 'wx' });
    } catch (error) {
      if (!isExistingFileError(error)) {
        throw error;
      }

      const raced = await this.read();
      if (raced.status === 'available' && raced.key.equals(key)) {
        return;
      }

      throw new Error('V2 safeStorage slot contains a different master key', { cause: error });
    }
  }
}

/**
 * Reads the historical `.mk` safeStorage format without ever modifying it.
 */
export class LegacySafeStorageProvider implements MasterKeyProvider {
  readonly source = 'legacy-safeStorage' as const;

  constructor(
    private readonly filePath: string,
    private readonly safeStorage: SafeStorageAdapter,
  ) {}

  async read(): Promise<KeyReadResult> {
    let encryptedKey: Buffer | null;
    try {
      encryptedKey = await readKeyFile(this.filePath);
    } catch (error) {
      return { status: 'unavailable', source: this.source, error };
    }

    if (!encryptedKey) {
      return { status: 'missing', source: this.source };
    }

    if (MASTER_KEY_HEX_PATTERN.test(encryptedKey.toString('utf8'))) {
      return { status: 'missing', source: this.source };
    }

    if (!this.safeStorage.isEncryptionAvailable()) {
      return {
        status: 'unavailable',
        source: this.source,
        error: new Error('safeStorage is unavailable'),
      };
    }

    try {
      const decryptedKey = this.safeStorage.decryptString(encryptedKey);
      if (!MASTER_KEY_HEX_PATTERN.test(decryptedKey)) {
        return {
          status: 'corrupt',
          source: this.source,
          error: new Error('Legacy safeStorage key has an invalid format'),
        };
      }

      return {
        status: 'available',
        source: this.source,
        key: Buffer.from(decryptedKey, 'hex'),
      };
    } catch (error) {
      return { status: 'unavailable', source: this.source, error };
    }
  }
}
