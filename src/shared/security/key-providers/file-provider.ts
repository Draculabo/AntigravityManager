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
}

export class LegacyFileMasterKeyProvider implements MasterKeyProvider {
  readonly source = 'legacy-file' as const;

  constructor(private readonly filePath: string) {}

  read(): Promise<KeyReadResult> {
    return readFileKey(this.filePath, this.source, 'missing');
  }
}
