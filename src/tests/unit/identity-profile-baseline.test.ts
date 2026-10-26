import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  agentDir: '',
  warn: vi.fn(),
}));

vi.mock('@/shared/platform/paths', () => ({
  getAgentDir: () => fixture.agentDir,
  getAntigravityDbPaths: () => [],
  getAntigravityStoragePaths: () => [],
}));
vi.mock('@/shared/logging/logger', () => ({
  logger: {
    error: vi.fn(),
    info: vi.fn(),
    warn: fixture.warn,
  },
}));

import {
  loadGlobalOriginalProfile,
  saveGlobalOriginalProfile,
} from '@/modules/identity-profile/ipc/handler';

describe('global identity-profile baseline boundary', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agm-profile-baseline-'));
    fixture.agentDir = tempDir;
    fixture.warn.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tempDir, { force: true, recursive: true });
  });

  it('loads a complete schema-valid baseline profile', () => {
    const profile = {
      machineId: 'machine-id',
      macMachineId: 'mac-machine-id',
      devDeviceId: 'device-id',
      sqmId: '{SQM-ID}',
    };
    fs.writeFileSync(path.join(tempDir, 'device_original.json'), JSON.stringify(profile), 'utf-8');

    expect(loadGlobalOriginalProfile()).toEqual(profile);
  });

  it('fails closed when the stored baseline does not match the device-profile schema', () => {
    fs.writeFileSync(
      path.join(tempDir, 'device_original.json'),
      JSON.stringify({ machineId: 'machine-id' }),
      'utf-8',
    );

    expect(loadGlobalOriginalProfile()).toBeNull();
    expect(fixture.warn).toHaveBeenCalledWith(
      'Failed to load global original device profile',
      expect.anything(),
    );
  });
  it('preserves a baseline created by another writer at publication', () => {
    const winner = {
      machineId: 'winner',
      macMachineId: 'winner-mac',
      devDeviceId: 'winner-dev',
      sqmId: '{WINNER}',
    };
    const candidate = {
      machineId: 'loser',
      macMachineId: 'loser-mac',
      devDeviceId: 'loser-dev',
      sqmId: '{LOSER}',
    };
    const link = fs.linkSync.bind(fs);
    vi.spyOn(fs, 'linkSync').mockImplementationOnce((source, destination) => {
      fs.writeFileSync(destination, JSON.stringify(winner), { encoding: 'utf8', flag: 'wx' });
      link(source, destination);
    });
    expect(() => saveGlobalOriginalProfile(candidate)).not.toThrow();
    expect(loadGlobalOriginalProfile()).toEqual(winner);
    expect(fs.readdirSync(tempDir)).toEqual(['device_original.json']);
  });
  it('preserves a baseline created just after its missing-file check', () => {
    const target = path.join(tempDir, 'device_original.json');
    const winner = {
      machineId: 'winner',
      macMachineId: 'winner-mac',
      devDeviceId: 'winner-dev',
      sqmId: '{WINNER}',
    };
    const exists = fs.existsSync.bind(fs);
    let injected = false;
    vi.spyOn(fs, 'existsSync').mockImplementation((file) => {
      const found = exists(file);
      if (file === target && !found && !injected) {
        injected = true;
        fs.writeFileSync(target, JSON.stringify(winner), 'utf8');
      }
      return found;
    });
    saveGlobalOriginalProfile({
      machineId: 'new',
      macMachineId: 'new-mac',
      devDeviceId: 'new-dev',
      sqmId: '{NEW}',
    });
    expect(loadGlobalOriginalProfile()).toEqual(winner);
    expect(fs.readdirSync(tempDir)).toEqual(['device_original.json']);
  });
  it('retains existing malformed baseline bytes instead of replacing them', () => {
    const target = path.join(tempDir, 'device_original.json');
    fs.writeFileSync(target, 'malformed-original', 'utf8');
    saveGlobalOriginalProfile({
      machineId: 'new',
      macMachineId: 'new-mac',
      devDeviceId: 'new-dev',
      sqmId: '{NEW}',
    });
    expect(fs.readFileSync(target, 'utf8')).toBe('malformed-original');
  });
  it('propagates an ordinary baseline write failure without retry', () => {
    const error = Object.assign(new Error('synthetic disk full'), { code: 'ENOSPC' });
    const write = vi.spyOn(fs, 'writeFileSync').mockImplementationOnce(() => {
      throw error;
    });
    expect(() =>
      saveGlobalOriginalProfile({
        machineId: 'new',
        macMachineId: 'new-mac',
        devDeviceId: 'new-dev',
        sqmId: '{NEW}',
      }),
    ).toThrow(error);
    expect(write).toHaveBeenCalledOnce();
    expect(fs.readdirSync(tempDir)).toEqual([]);
  });
  it('retains both publication and cleanup failures without publishing partial data', () => {
    const publication = Object.assign(new Error('synthetic publish failure'), { code: 'EACCES' });
    const cleanup = Object.assign(new Error('synthetic cleanup failure'), { code: 'EBUSY' });
    vi.spyOn(fs, 'linkSync').mockImplementationOnce(() => {
      throw publication;
    });
    vi.spyOn(fs, 'rmSync').mockImplementationOnce(() => {
      throw cleanup;
    });
    let failure: unknown;
    try {
      saveGlobalOriginalProfile({
        machineId: 'new',
        macMachineId: 'new-mac',
        devDeviceId: 'new-dev',
        sqmId: '{NEW}',
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure).toMatchObject({ errors: [publication, cleanup] });
    expect(fs.existsSync(path.join(tempDir, 'device_original.json'))).toBe(false);
  });
  it('keeps a complete published baseline when temporary-name cleanup fails', () => {
    const profile = {
      machineId: 'new',
      macMachineId: 'new-mac',
      devDeviceId: 'new-dev',
      sqmId: '{NEW}',
    };
    const cleanup = Object.assign(new Error('synthetic cleanup failure'), { code: 'EBUSY' });
    vi.spyOn(fs, 'rmSync').mockImplementationOnce(() => {
      throw cleanup;
    });
    expect(() => saveGlobalOriginalProfile(profile)).toThrow(cleanup);
    expect(loadGlobalOriginalProfile()).toEqual(profile);
    expect(fs.readdirSync(tempDir)).toHaveLength(2);
  });
});
