import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockedPaths = vi.hoisted(() => ({
  agentDir: '',
  storagePath: '',
}));

vi.mock('@/shared/platform/paths', () => ({
  getAgentDir: () => mockedPaths.agentDir,
  getAntigravityDbPaths: () => [],
  getAntigravityStoragePaths: () => [mockedPaths.storagePath],
}));

import {
  ensureGlobalOriginalFromCurrentStorage,
  saveGlobalOriginalProfile,
} from '@/modules/identity-profile/ipc/handler';
import type { DeviceProfile } from '@/modules/identity-profile/types';

const originalProfile: DeviceProfile = {
  machineId: 'original-machine',
  macMachineId: 'original-mac',
  devDeviceId: 'original-device',
  sqmId: 'original-sqm',
};

const generatedProfile: DeviceProfile = {
  machineId: 'generated-machine',
  macMachineId: 'generated-mac',
  devDeviceId: 'generated-device',
  sqmId: 'generated-sqm',
};

function writeStorage(profile: Partial<DeviceProfile>): void {
  fs.writeFileSync(
    mockedPaths.storagePath,
    JSON.stringify({
      telemetry: {
        machineId: profile.machineId,
        macMachineId: profile.macMachineId,
        devDeviceId: profile.devDeviceId,
        sqmId: profile.sqmId,
      },
    }),
    'utf-8',
  );
}

describe('identity profile original baseline', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agm-device-baseline-'));
    mockedPaths.agentDir = path.join(tempDir, 'agent');
    mockedPaths.storagePath = path.join(tempDir, 'storage.json');
    fs.mkdirSync(mockedPaths.agentDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('captures the baseline only from the current storage profile', () => {
    writeStorage(originalProfile);

    ensureGlobalOriginalFromCurrentStorage();

    const baselinePath = path.join(mockedPaths.agentDir, 'device_original.json');
    expect(JSON.parse(fs.readFileSync(baselinePath, 'utf-8'))).toEqual(originalProfile);
  });

  it('does not create a baseline when current storage cannot provide a complete profile', () => {
    writeStorage({ machineId: originalProfile.machineId });

    ensureGlobalOriginalFromCurrentStorage();
    saveGlobalOriginalProfile(generatedProfile);

    expect(fs.existsSync(path.join(mockedPaths.agentDir, 'device_original.json'))).toBe(false);
  });

  it('rejects a profile that does not match the verified storage source', () => {
    writeStorage(originalProfile);

    saveGlobalOriginalProfile(generatedProfile, mockedPaths.storagePath);

    expect(fs.existsSync(path.join(mockedPaths.agentDir, 'device_original.json'))).toBe(false);
  });
});
