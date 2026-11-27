import fs from 'node:fs';
import { isEqual } from 'lodash-es';
import { hasErrorCode } from '@/shared/errors/error-guards';
import { writePrivateFileAtomically } from '@/shared/persistence/privateFile';
import {
  WINDOWS_CREDENTIAL_TARGET,
  WINDOWS_CREDENTIAL_USERNAME,
  writeVerifiedWindowsAntigravityCredential,
} from './antigravityCredentialStore';
import { writeAgyCliToken } from './agyCliTokenStore';
import {
  writeGoogleOAuthCredentials,
  type GoogleOAuthCredentialInput,
} from './googleOAuthCredentialStore';
import {
  matchesWindowsCredentialWrite,
  readWindowsCredentialSnapshot,
  restoreWindowsCredentialSnapshot,
} from './windowsCredentialStore';

export class WindowsAgyCredentialWriteError extends AggregateError {
  constructor(
    readonly primary: unknown,
    failures: readonly unknown[],
  ) {
    super(
      [primary, ...failures],
      failures.length
        ? 'Windows agy credential recovery could not be confirmed'
        : 'Windows agy credential switch failed and prior state was restored',
    );
    this.name = 'WindowsAgyCredentialWriteError';
    this.rollback = failures.length ? 'failed' : 'succeeded';
  }

  readonly rollback: 'failed' | 'succeeded';
}

interface CredentialFileWrite {
  file: string;
  before: Buffer | null;
  replacement: Buffer;
}

const MAX_CREDENTIAL_FILE_BYTES = 512 * 1024;

function readCredentialFile(file: string): Buffer | null {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size > MAX_CREDENTIAL_FILE_BYTES) {
      throw new Error('Windows agy credential destination is not a bounded regular file');
    }
    return fs.readFileSync(file);
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) {
      return null;
    }
    throw error;
  }
}

function restoreCredentialFile({ file, before, replacement }: CredentialFileWrite): void {
  const current = readCredentialFile(file);
  if (isEqual(current, before)) {
    return;
  }
  if (!isEqual(current, replacement)) {
    throw new Error('Windows agy credential file changed during switch');
  }
  if (before === null) {
    fs.rmSync(file);
  } else {
    writePrivateFileAtomically(file, before);
  }
  if (!isEqual(readCredentialFile(file), before)) {
    throw new Error('Windows agy credential file recovery readback failed');
  }
}

/** Runs under the switch owner. The recovery snapshot stays in memory. */
export async function writeWindowsAgyAccount(
  input: GoogleOAuthCredentialInput,
  cliPayload: string,
  windowsPayload: string,
): Promise<void> {
  const target = WINDOWS_CREDENTIAL_TARGET;
  const before = await readWindowsCredentialSnapshot(target);
  const files: CredentialFileWrite[] = [];
  let nativeWriteAttempted = false;
  const writeFile = (file: string, payload: string) => {
    const replacement = Buffer.from(payload, 'utf8');
    files.push({ file, before: readCredentialFile(file), replacement });
    writePrivateFileAtomically(file, replacement);
    if (!isEqual(readCredentialFile(file), replacement)) {
      throw new Error('Windows agy credential file write could not be confirmed');
    }
  };
  try {
    writeAgyCliToken(cliPayload, writeFile);
    writeGoogleOAuthCredentials(input, { writeFile });
    if (!isEqual(await readWindowsCredentialSnapshot(target), before)) {
      throw new Error('Windows agy system credential changed before the proposed switch');
    }
    nativeWriteAttempted = true;
    await writeVerifiedWindowsAntigravityCredential(windowsPayload);
    for (const { file, replacement } of files) {
      if (!isEqual(readCredentialFile(file), replacement)) {
        throw new Error('Windows agy credential file changed during switch');
      }
    }
  } catch (primary) {
    if (!nativeWriteAttempted && files.length === 0) {
      throw primary;
    }
    const failures: unknown[] = [];
    try {
      const current = await readWindowsCredentialSnapshot(target);
      if (!isEqual(current, before)) {
        if (
          !nativeWriteAttempted ||
          !matchesWindowsCredentialWrite(current, WINDOWS_CREDENTIAL_USERNAME, windowsPayload)
        ) {
          throw new Error('Windows agy system credential changed during switch');
        }
        await restoreWindowsCredentialSnapshot(target, before);
      }
    } catch (error) {
      failures.push(error);
    }
    for (const file of files.reverse()) {
      try {
        restoreCredentialFile(file);
      } catch (error) {
        failures.push(error);
      }
    }
    throw new WindowsAgyCredentialWriteError(primary, failures);
  } finally {
    for (const file of files) {
      file.before?.fill(0);
      file.replacement.fill(0);
    }
  }
}
