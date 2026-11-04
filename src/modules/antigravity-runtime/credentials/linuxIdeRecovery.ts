import fs from 'node:fs';
import { z } from 'zod';
import { decodeCredentialFileJson } from '@/shared/security/credential-file-text';
import { writePrivateFileAtomically } from '@/shared/persistence/privateFile';
import { hasErrorCode } from '@/shared/errors/error-guards';
import { getAntigravityDbPaths, type PathResolutionOptions } from '@/shared/platform/paths';
import { observeProcesses } from '../processObserver';
import { runWithSwitchGuard } from '../switch/switchGuard';
import { getIdeStandaloneTokenPath, validateIdeStandaloneDestination } from './ideStandaloneToken';
import {
  LinuxIdeCredentialSnapshotSchema,
  readLinuxIdeCredentialSnapshot,
  restoreLinuxIdeCredentialSnapshot,
} from './linuxIdeCredentialStore';

const SUFFIX = '.account-switch.linux-credentials.backup';
// Linux recovery retains each Secret Service item; Windows owns its separate metadata codec.
const RecoverySchema = z.strictObject({
  version: z.literal(1),
  standalonePath: z.string(),
  credentials: LinuxIdeCredentialSnapshotSchema,
  standalone: z
    .strictObject({
      bytes: z
        .base64()
        .max(90000)
        .refine((value) => Buffer.from(value, 'base64').length <= 65536),
      mode: z.number().int().min(0).max(0o777),
    })
    .nullable(),
});

function readFile(file: string, limit: number): Buffer | null {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit) {
      throw new Error('Linux IDE recovery requires a bounded regular file');
    }
    return fs.readFileSync(file);
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) {
      return null;
    }
    throw error;
  }
}

export async function prepareLinuxIdeRecovery(database: string): Promise<() => Promise<void>> {
  const backup = `${database}${SUFFIX}`;
  const previous = readFile(backup, 512 * 1024)?.toString('utf8');
  if (previous) {
    if (!RecoverySchema.safeParse(await decodeCredentialFileJson(previous)).success) {
      throw new Error('Linux IDE credential recovery backup is malformed');
    }
  }
  await readLinuxIdeCredentialSnapshot();
  validateIdeStandaloneDestination();
  readFile(getIdeStandaloneTokenPath(), 65536);
  let saved = false;
  return async () => {
    if (saved) {
      return;
    }
    const standalonePath = getIdeStandaloneTokenPath();
    const bytes = readFile(standalonePath, 65536);
    const snapshot: z.infer<typeof RecoverySchema> = {
      version: 1,
      standalonePath,
      credentials: await readLinuxIdeCredentialSnapshot(),
      standalone:
        bytes === null
          ? null
          : {
              bytes: bytes.toString('base64'),
              mode: fs.statSync(standalonePath).mode & 0o777,
            },
    };
    const serialized = JSON.stringify(snapshot);
    if (Buffer.byteLength(serialized) > 350000) {
      throw new Error('Linux IDE recovery snapshot exceeds its size limit');
    }
    const payload = serialized;
    writePrivateFileAtomically(backup, payload);
    if (fs.readFileSync(backup, 'utf8') !== payload) {
      throw new Error('Linux IDE recovery backup could not be confirmed');
    }
    saved = true;
  };
}

/** Trusted maintenance API: stop the Manager/Core owner and every official desktop client first. */
export async function restoreLinuxIdeCredentials(options?: PathResolutionOptions): Promise<void> {
  await runWithSwitchGuard(
    'ide-credential-recovery',
    async () => {
      if (process.platform !== 'linux') {
        throw new Error('Linux IDE recovery requires Linux');
      }
      const clients = await Promise.all([observeProcesses('ide'), observeProcesses('classic')]);
      if (clients.some((rows) => rows.length > 0)) {
        throw new Error('Close every Antigravity IDE and App before credential recovery');
      }
      const database = getAntigravityDbPaths('ide', options).find((file) =>
        fs.existsSync(`${file}${SUFFIX}`),
      );
      const payload = database ? readFile(`${database}${SUFFIX}`, 512 * 1024) : null;
      if (!payload) {
        throw new Error('Linux IDE credential recovery backup is unavailable');
      }
      const decoded = await decodeCredentialFileJson(payload.toString('utf8'));
      const saved = RecoverySchema.safeParse(decoded);
      if (!saved.success || saved.data.standalonePath !== getIdeStandaloneTokenPath()) {
        throw new Error('Linux IDE credential recovery backup does not match this environment');
      }
      validateIdeStandaloneDestination();
      await restoreLinuxIdeCredentialSnapshot(saved.data.credentials);
      const { standalone, standalonePath } = saved.data;
      if (standalone === null) {
        fs.rmSync(standalonePath, { force: true });
        if (fs.existsSync(standalonePath)) {
          throw new Error('Linux IDE standalone credential deletion failed');
        }
      } else {
        const bytes = Buffer.from(standalone.bytes, 'base64');
        writePrivateFileAtomically(standalonePath, bytes);
        fs.chmodSync(standalonePath, standalone.mode);
        if (!fs.readFileSync(standalonePath).equals(bytes)) {
          throw new Error('Linux IDE standalone credential recovery readback failed');
        }
      }
    },
    'ide',
  );
}
