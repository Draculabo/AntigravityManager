import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { DeviceProfile } from '../types';
import { publishProfileFileIfMissing } from './publish-profile-file';

const StorageObjectSchema = z.record(z.string(), z.unknown());

/** Create a missing file without replacing an existing application's state. */
export function initializeStorageFile(
  storagePath: string,
  createProfile: () => DeviceProfile,
): string {
  const directory = path.dirname(storagePath);
  publishProfileFileIfMissing(storagePath, () => {
    const profile = createProfile();
    return `${JSON.stringify(
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
    )}\n`;
  });

  const content = fs.readFileSync(storagePath, 'utf8').replace(/^\uFEFF/, '');
  const parsed: unknown = JSON.parse(content);
  StorageObjectSchema.parse(parsed);
  fs.accessSync(storagePath, fs.constants.W_OK);
  fs.accessSync(directory, fs.constants.W_OK);
  return storagePath;
}
