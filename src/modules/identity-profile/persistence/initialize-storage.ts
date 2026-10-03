import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { DeviceProfile } from '../types';

const StorageObjectSchema = z.record(z.string(), z.unknown());

/** Create a missing file without replacing an existing application's state. */
export function initializeStorageFile(
  storagePath: string,
  createProfile: () => DeviceProfile,
): string {
  const directory = path.dirname(storagePath);
  if (!fs.existsSync(storagePath)) {
    fs.mkdirSync(directory, { recursive: true });
    const profile = createProfile();
    const temporaryPath = path.join(directory, `.storage-${randomUUID()}.tmp`);
    try {
      fs.writeFileSync(
        temporaryPath,
        `${JSON.stringify(
          {
            'telemetry.machineId': profile.machineId,
            'telemetry.macMachineId': profile.macMachineId,
            'telemetry.devDeviceId': profile.devDeviceId,
            'telemetry.sqmId': profile.sqmId,
            'storage.serviceMachineId': profile.devDeviceId,
            telemetry: profile,
          },
          null,
          2,
        )}\n`,
        { encoding: 'utf8', flag: 'wx', mode: 0o600 },
      );
      try {
        // Publishing a complete inode is atomic and EEXIST preserves a concurrent creator.
        fs.linkSync(temporaryPath, storagePath);
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) {
          throw error;
        }
      }
    } finally {
      fs.rmSync(temporaryPath, { force: true });
    }
  }

  const content = fs.readFileSync(storagePath, 'utf8').replace(/^\uFEFF/, '');
  const parsed: unknown = JSON.parse(content);
  StorageObjectSchema.parse(parsed);
  fs.accessSync(storagePath, fs.constants.W_OK);
  fs.accessSync(directory, fs.constants.W_OK);
  return storagePath;
}
