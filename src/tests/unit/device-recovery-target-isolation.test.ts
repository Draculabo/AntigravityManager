import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DeviceProfile } from '@/modules/identity-profile/types';

const pathState = vi.hoisted(() => ({
  agentDir: '',
  storagePaths: {} as Record<string, string>,
  dbPaths: {} as Record<string, string>,
}));

vi.mock('@/shared/platform/paths', () => ({
  getAgentDir: () => pathState.agentDir,
  getAntigravityStoragePaths: (target?: string) => {
    const resolved = target === 'ide' || target === 'agy' ? target : 'classic';
    const storagePath = pathState.storagePaths[resolved];
    return storagePath ? [storagePath] : [];
  },
  getAntigravityDbPaths: (target?: string) => {
    const resolved = target === 'ide' || target === 'agy' ? target : 'classic';
    const dbPath = pathState.dbPaths[resolved];
    return dbPath ? [dbPath] : [];
  },
}));

import { applyDeviceProfile } from '@/modules/identity-profile/ipc/handler';

const initialProfile: DeviceProfile = {
  machineId: 'initial-machine',
  macMachineId: 'initial-mac',
  devDeviceId: 'initial-device',
  sqmId: 'initial-sqm',
};

const classicProfile: DeviceProfile = {
  machineId: 'classic-machine',
  macMachineId: 'classic-mac',
  devDeviceId: 'classic-device',
  sqmId: 'classic-sqm',
};

const ideProfile: DeviceProfile = {
  machineId: 'ide-machine',
  macMachineId: 'ide-mac',
  devDeviceId: 'ide-device',
  sqmId: 'ide-sqm',
};

function prepareTarget(rootDir: string, target: 'classic' | 'ide'): void {
  const targetDir = path.join(rootDir, target);
  const storagePath = path.join(targetDir, 'storage.json');
  const dbPath = path.join(targetDir, 'state.vscdb');

  fs.mkdirSync(targetDir, { recursive: true });
  fs.writeFileSync(
    storagePath,
    JSON.stringify({
      telemetry: {
        machineId: initialProfile.machineId,
        macMachineId: initialProfile.macMachineId,
        devDeviceId: initialProfile.devDeviceId,
        sqmId: initialProfile.sqmId,
      },
      'storage.serviceMachineId': initialProfile.devDeviceId,
    }),
  );

  const db = new Database(dbPath);
  try {
    db.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT);');
    db.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)').run(
      'storage.serviceMachineId',
      initialProfile.devDeviceId,
    );
  } finally {
    db.close();
  }

  pathState.storagePaths[target] = storagePath;
  pathState.dbPaths[target] = dbPath;
}

describe('device recovery target isolation', () => {
  let rootDir: string;

  beforeEach(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agm-device-recovery-'));
    pathState.agentDir = path.join(rootDir, 'agent');
    pathState.storagePaths = {};
    pathState.dbPaths = {};
    prepareTarget(rootDir, 'classic');
    prepareTarget(rootDir, 'ide');
  });

  afterEach(() => {
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  it('keeps last-known-good snapshots isolated for classic and IDE targets', () => {
    applyDeviceProfile(classicProfile, 'classic');
    applyDeviceProfile(ideProfile, 'ide');

    const recoveryRoot = path.join(pathState.agentDir, 'device_last_known_good');
    const classicStorage = JSON.parse(
      fs.readFileSync(path.join(recoveryRoot, 'classic', 'storage.json'), 'utf-8'),
    ) as { telemetry: { machineId: string } };
    const ideStorage = JSON.parse(
      fs.readFileSync(path.join(recoveryRoot, 'ide', 'storage.json'), 'utf-8'),
    ) as { telemetry: { machineId: string } };
    const classicMarker = JSON.parse(
      fs.readFileSync(path.join(recoveryRoot, 'classic', 'marker.json'), 'utf-8'),
    ) as { target: string; storageDirectory: string };
    const ideMarker = JSON.parse(
      fs.readFileSync(path.join(recoveryRoot, 'ide', 'marker.json'), 'utf-8'),
    ) as { target: string; storageDirectory: string };

    expect(classicStorage.telemetry.machineId).toBe(classicProfile.machineId);
    expect(ideStorage.telemetry.machineId).toBe(ideProfile.machineId);
    expect(classicMarker).toMatchObject({
      target: 'classic',
      storageDirectory: path.dirname(pathState.storagePaths.classic),
    });
    expect(ideMarker).toMatchObject({
      target: 'ide',
      storageDirectory: path.dirname(pathState.storagePaths.ide),
    });
    expect(fs.existsSync(path.join(recoveryRoot, 'storage.json'))).toBe(false);
  });
});
