import fs from 'fs/promises';
import type { KeyReadResult, MasterKeyProvider } from '@/shared/security/master-key-manager';

const MASTER_KEY_HEX_PATTERN = /^[a-f0-9]{64}$/i;

function isFileError(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException).code === code;
}

async function readFileKey(
  filePath: string,
  source: 'file' | 'legacy-file',
  invalidContentStatus: 'missing' | 'corrupt',
): Promise<KeyReadResult> {
  try {
    const content = await fs.readFile(filePath, 'utf8');
    if (!MASTER_KEY_HEX_PATTERN.test(content)) {
      if (invalidContentStatus === 'missing') {
        return { status: 'missing', source };
      }

      return {
        status: 'corrupt',
        source,
        error: new Error(`${source} key has an invalid format`),
      };
    }

    return { status: 'available', source, key: Buffer.from(content, 'hex') };
  } catch (error) {
    if (isFileError(error, 'ENOENT')) {
      return { status: 'missing', source };
    }

    return { status: 'unavailable', source, error };
  }
}

export class FileMasterKeyProvider implements MasterKeyProvider {
  readonly source = 'file' as const;

  constructor(private readonly filePath: string) {}

  read(): Promise<KeyReadResult> {
    return readFileKey(this.filePath, this.source, 'corrupt');
  }

  async write(key: Buffer): Promise<void> {
    const existing = await this.read();
    if (existing.status === 'available') {
      if (existing.key.equals(key)) {
        return;
      }

      throw new Error('V2 compatibility slot contains a different master key');
    }
    if (existing.status !== 'missing') {
      throw new Error('V2 compatibility slot is not writable', { cause: existing.error });
    }

    try {
      await fs.writeFile(this.filePath, key.toString('hex'), {
        encoding: 'utf8',
        mode: 0o600,
        flag: 'wx',
      });
    } catch (error) {
      if (!isFileError(error, 'EEXIST')) {
        throw error;
      }

      const raced = await this.read();
      if (raced.status === 'available' && raced.key.equals(key)) {
        return;
      }

      throw new Error('V2 compatibility slot contains a different master key', { cause: error });
    }
  }
}

export class LegacyFileMasterKeyProvider implements MasterKeyProvider {
  readonly source = 'legacy-file' as const;

  constructor(private readonly filePath: string) {}

  read(): Promise<KeyReadResult> {
    return readFileKey(this.filePath, this.source, 'missing');
  }
}
