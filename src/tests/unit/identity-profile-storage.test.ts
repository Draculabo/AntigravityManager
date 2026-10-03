import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initializeStorageFile } from '@/modules/identity-profile/persistence/initialize-storage';
import {
  generateDeviceProfile,
  ensureIdentityProfileStorage,
  getStoragePath,
} from '@/modules/identity-profile/ipc/handler';
import * as platformPaths from '@/shared/platform/paths';

describe('missing identity-profile storage', () => {
  let root: string;
  let file: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'agm-storage-init-'));
    file = path.join(root, 'User', 'globalStorage', 'storage.json');
  });
  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('creates complete unique identifiers and retains them on repeated initialization', () => {
    const profile = generateDeviceProfile();
    const factory = vi.fn(() => profile);
    initializeStorageFile(file, factory);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({
      'telemetry.machineId': profile.machineId,
      'telemetry.macMachineId': profile.macMachineId,
      'telemetry.devDeviceId': profile.devDeviceId,
      'telemetry.sqmId': profile.sqmId,
      'storage.serviceMachineId': profile.devDeviceId,
      telemetry: profile,
    });
    const original = fs.readFileSync(file, 'utf8');
    initializeStorageFile(file, factory);
    expect(fs.readFileSync(file, 'utf8')).toBe(original);
    expect(factory).toHaveBeenCalledTimes(1);
    const other = path.join(root, 'other', 'storage.json');
    initializeStorageFile(other, generateDeviceProfile);
    expect(JSON.parse(fs.readFileSync(other, 'utf8')).telemetry).not.toEqual(profile);
    expect(fs.readdirSync(path.dirname(file))).toEqual(['storage.json']);
  });

  it('keeps reads pure and initializes only the explicitly captured target directory', () => {
    const custom = path.join(root, 'custom');
    const defaultFile = path.join(root, 'default', 'storage.json');
    fs.mkdirSync(path.dirname(defaultFile), { recursive: true });
    fs.writeFileSync(defaultFile, '{"keep":"default"}');
    const resolution = vi
      .spyOn(platformPaths, 'getAntigravityStoragePaths')
      .mockImplementation((_target, options) => {
        return options?.userDataDir
          ? [path.join(options.userDataDir, 'User', 'globalStorage', 'storage.json')]
          : [defaultFile];
      });
    const options = { userDataDir: custom, ignoreRunningProcessCache: true };
    expect(() => getStoragePath('ide', options)).toThrow('storage_json_not_found');
    expect(fs.existsSync(custom)).toBe(false);
    const initialized = ensureIdentityProfileStorage('ide', options);
    expect(initialized).toBe(path.join(custom, 'User', 'globalStorage', 'storage.json'));
    expect(getStoragePath('ide', options)).toBe(initialized);
    expect(fs.readFileSync(defaultFile, 'utf8')).toBe('{"keep":"default"}');
    expect(resolution).toHaveBeenCalledWith('ide', options);
  });

  it('preserves existing fields and byte representation, including BOM', () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const original = '\uFEFF{ "other-setting": true, "telemetry": { "custom": "keep" } }';
    fs.writeFileSync(file, original);
    const factory = vi.fn(generateDeviceProfile);
    initializeStorageFile(file, factory);
    expect(fs.readFileSync(file, 'utf8')).toBe(original);
    expect(factory).not.toHaveBeenCalled();
  });

  it.each(['{broken', '[]', 'null', '"text"'])(
    'rejects invalid existing storage without overwriting: %s',
    (original) => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, original);
      expect(() => initializeStorageFile(file, generateDeviceProfile)).toThrow();
      expect(fs.readFileSync(file, 'utf8')).toBe(original);
    },
  );

  it('retains another creator winning the atomic publication', () => {
    const link = fs.linkSync;
    const original = '{"other-setting":"created elsewhere"}';
    vi.spyOn(fs, 'linkSync').mockImplementationOnce((source, destination) => {
      fs.writeFileSync(destination, original);
      link(source, destination);
    });
    initializeStorageFile(file, generateDeviceProfile);
    expect(fs.readFileSync(file, 'utf8')).toBe(original);
    expect(fs.readdirSync(path.dirname(file))).toEqual(['storage.json']);
  });

  it('propagates access failures and removes temporary state', () => {
    vi.spyOn(fs, 'linkSync').mockImplementationOnce(() => {
      throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
    });
    expect(() => initializeStorageFile(file, generateDeviceProfile)).toThrow('permission denied');
    expect(fs.readdirSync(path.dirname(file))).toEqual([]);
  });
});
