import fs from 'node:fs';
import { z } from 'zod';
import { decodeCredentialFileJson } from '@/shared/security/credential-file-text';
import { writePrivateFileAtomically } from '@/shared/persistence/privateFile';
import { hasErrorCode } from '@/shared/errors/error-guards';
import { observeProcesses } from '../processObserver';
import { runWithSwitchGuard } from '../switch/switchGuard';
import { getAntigravityDbPaths, type PathResolutionOptions } from '@/shared/platform/paths';
import { getIdeStandaloneTokenPath, validateIdeStandaloneDestination } from './ideStandaloneToken';
import {
  readWindowsCredentialSnapshot,
  restoreWindowsCredentialSnapshot,
  WindowsCredentialSnapshotSchema,
} from './windowsCredentialStore';

const TARGET = 'gemini:antigravity';
const MAX_BYTES = 512 * 1024;
const RecoverySchema = z.strictObject({
  version: z.literal(1),
  standalonePath: z.string(),
  credential: WindowsCredentialSnapshotSchema.nullable(),
  standalone: z
    .strictObject({
      bytes: z
        .base64()
        .max(90000)
        .refine((value) => Buffer.from(value, 'base64').length <= 64 * 1024),
      mode: z.number().int().min(0).max(0o777),
    })
    .nullable(),
});

function readBoundedFile(file: string, limit = MAX_BYTES): Buffer | null {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit) {
      throw new Error('IDE credential recovery file is not a bounded regular file');
    }
    return fs.readFileSync(file);
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) {
      return null;
    }
    throw error;
  }
}

/** Preflight checks recovery access; capture runs again after the client has stopped. */
export async function prepareWindowsIdeRecovery(dbPath: string): Promise<() => Promise<void>> {
  const recoveryPath = `${dbPath}.account-switch.credentials.backup`;
  const existing = readBoundedFile(recoveryPath)?.toString('utf8');
  if (existing) {
    if (!RecoverySchema.safeParse(await decodeCredentialFileJson(existing)).success) {
      throw new Error('IDE credential recovery backup is malformed');
    }
  }
  await readWindowsCredentialSnapshot(TARGET);
  readBoundedFile(getIdeStandaloneTokenPath(), 64 * 1024);
  let saved = false;
  return async () => {
    if (saved) {
      return;
    }
    const standalonePath = getIdeStandaloneTokenPath();
    const bytes = readBoundedFile(standalonePath, 64 * 1024);
    const snapshot: z.infer<typeof RecoverySchema> = {
      version: 1,
      standalonePath,
      credential: await readWindowsCredentialSnapshot(TARGET),
      standalone:
        bytes === null
          ? null
          : {
              bytes: bytes.toString('base64'),
              mode: fs.statSync(standalonePath).mode & 0o777,
            },
    };
    const payload = JSON.stringify(snapshot);
    writePrivateFileAtomically(recoveryPath, payload);
    if (fs.readFileSync(recoveryPath, 'utf8') !== payload) {
      throw new Error('IDE credential recovery backup could not be confirmed');
    }
    saved = true;
  };
}

/** Manual recovery only: restore credentials with all official desktop clients closed. */
export async function restoreWindowsIdeCredentials(
  pathOptions?: PathResolutionOptions,
): Promise<void> {
  await runWithSwitchGuard(
    'ide-credential-recovery',
    () => restoreStoppedIdeCredentials(pathOptions),
    'ide',
  );
}

async function restoreStoppedIdeCredentials(pathOptions?: PathResolutionOptions): Promise<void> {
  if (process.platform !== 'win32') {
    throw new Error('Windows IDE credential recovery requires Windows');
  }
  const clients = await Promise.all([observeProcesses('ide'), observeProcesses('classic')]);
  if (clients.some((rows) => rows.length > 0)) {
    throw new Error('Close every Antigravity IDE and App before credential recovery');
  }
  const dbPath = getAntigravityDbPaths('ide', pathOptions).find((file) =>
    fs.existsSync(`${file}.account-switch.credentials.backup`),
  );
  if (!dbPath) {
    throw new Error('IDE credential recovery backup is unavailable');
  }
  const payload = readBoundedFile(`${dbPath}.account-switch.credentials.backup`);
  if (!payload) {
    throw new Error('IDE credential recovery backup is unavailable');
  }
  const json = await decodeCredentialFileJson(payload.toString('utf8'));
  const result = RecoverySchema.safeParse(json);
  if (!result.success || result.data.standalonePath !== getIdeStandaloneTokenPath()) {
    throw new Error('IDE credential recovery backup does not match this environment');
  }
  const { credential, standalone, standalonePath } = result.data;
  validateIdeStandaloneDestination();
  await restoreWindowsCredentialSnapshot(TARGET, credential);
  if (standalone === null) {
    fs.rmSync(standalonePath, { force: true });
    if (fs.existsSync(standalonePath)) {
      throw new Error('IDE standalone credential recovery deletion failed');
    }
  } else {
    const bytes = Buffer.from(standalone.bytes, 'base64');
    writePrivateFileAtomically(standalonePath, bytes);
    fs.chmodSync(standalonePath, standalone.mode);
    if (!fs.readFileSync(standalonePath).equals(bytes)) {
      throw new Error('IDE standalone credential recovery readback failed');
    }
  }
}
