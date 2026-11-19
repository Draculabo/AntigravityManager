import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import { hasErrorCode } from '@/shared/errors/error-guards';
import { writeFileAtomic } from '@/shared/persistence/atomic-json-file';
import { readConnectionFile } from './connection-profile-native';
import { ConnectionProfileError } from './connection-profiles.schema';

export const nativeConfigFingerprintSchema = z.strictObject({
  filename: z.string(),
  beforeHash: z.string(),
  afterHash: z.string(),
});

export const followingConfigWriteSchema = nativeConfigFingerprintSchema.extend({
  afterSource: z.string().max(1024 * 1024),
});

type Fingerprint = z.infer<typeof nativeConfigFingerprintSchema>;
type FollowingWrite = z.infer<typeof followingConfigWriteSchema>;

export interface NativeConfigWrite {
  filename: string;
  source: string | null;
  updated: string;
}

function sourceHash(source: string | null): string {
  return createHash('sha256')
    .update(source ?? 'absent')
    .digest('hex');
}

export function describeNativeWrite(write: NativeConfigWrite): Fingerprint {
  return {
    filename: write.filename,
    beforeHash: sourceHash(write.source),
    afterHash: sourceHash(write.updated),
  };
}

function checkSource(filename: string, expected: string | null): void {
  let current: string | null;
  try {
    current = readFileSync(filename, 'utf8');
  } catch (error) {
    if (!hasErrorCode(error, 'ENOENT')) {
      throw error;
    }
    current = null;
  }
  if (current !== expected) {
    throw new ConnectionProfileError('conflict');
  }
}

export async function writeNativeConfig(
  write: NativeConfigWrite,
  preceding?: { filename: string; updated: string },
): Promise<void> {
  try {
    await mkdir(dirname(write.filename), { recursive: true, mode: 0o700 });
    await writeFileAtomic(write.filename, write.updated, {
      mode: 0o600,
      beforeCommit: () => {
        checkSource(write.filename, write.source);
        if (preceding) {
          checkSource(preceding.filename, preceding.updated);
        }
      },
    });
    if ((await readConnectionFile(write.filename)) !== write.updated) {
      throw new ConnectionProfileError('write-unconfirmed');
    }
    if (preceding && (await readConnectionFile(preceding.filename)) !== preceding.updated) {
      throw new ConnectionProfileError('conflict');
    }
  } catch (cause) {
    throw cause instanceof ConnectionProfileError
      ? cause
      : new ConnectionProfileError('write-failed', cause);
  }
}

/** Resume only the remaining write from the authorized journal, against both verified snapshots. */
export async function recoverNativeConfig(
  first: Fingerprint,
  following?: FollowingWrite,
): Promise<'before' | 'after'> {
  const firstSource = await readConnectionFile(first.filename);
  const firstHash = sourceHash(firstSource);
  if (!following) {
    if (firstHash === first.afterHash) {
      return 'after';
    }
    if (firstHash === first.beforeHash) {
      return 'before';
    }
    throw new ConnectionProfileError('conflict');
  }

  const source = await readConnectionFile(following.filename);
  const current = sourceHash(source);
  if (firstHash === first.beforeHash && current === following.beforeHash) {
    return 'before';
  }
  if (firstHash !== first.afterHash || firstSource === null) {
    throw new ConnectionProfileError('conflict');
  }
  if (current === following.afterHash) {
    return 'after';
  }
  if (
    current !== following.beforeHash ||
    sourceHash(following.afterSource) !== following.afterHash
  ) {
    throw new ConnectionProfileError('conflict');
  }
  await writeNativeConfig(
    { filename: following.filename, source, updated: following.afterSource },
    { filename: first.filename, updated: firstSource },
  );
  return 'after';
}
