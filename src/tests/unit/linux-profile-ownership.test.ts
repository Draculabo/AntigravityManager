import fs from 'node:fs';
import os from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ownsLinuxProfile } from '@/modules/antigravity-runtime/linuxProfileOwnership';

const mocks = vi.hoisted(() => ({ readdir: vi.fn() }));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, default: { ...actual, readdirSync: mocks.readdir } };
});

const platform = process.platform;
const profile = '/isolated/profile';
let singleton: string;
let openFile: string;
let parent: number;

beforeEach(() => {
  Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
  singleton = 'fixture-host-42';
  openFile = `${profile}/Local Storage/leveldb/LOCK`;
  parent = 42;
  vi.spyOn(os, 'hostname').mockReturnValue('fixture-host');
  vi.spyOn(fs, 'realpathSync').mockImplementation((file) => {
    const value = String(file);
    if (value === profile) {
      return profile;
    }
    if (value === '/proc/42/exe' || value === '/proc/43/exe') {
      return '/installed/antigravity';
    }
    throw new Error('unavailable');
  });
  vi.spyOn(fs, 'readlinkSync').mockImplementation((file) => {
    if (String(file) === `${profile}/SingletonLock`) {
      return singleton;
    }
    if (String(file) === '/proc/42/fd/7') {
      return openFile;
    }
    throw new Error('unavailable');
  });
  mocks.readdir.mockReturnValue(['7']);
  vi.spyOn(fs, 'readFileSync').mockImplementation(() => `PPid:\t${parent}\n`);
});
afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
});

describe('live Linux profile ownership', () => {
  it('confirms the live singleton owner and its same-executable child', () => {
    expect([ownsLinuxProfile(42, profile), ownsLinuxProfile(43, profile)]).toEqual([true, true]);
  });
  it('rejects a stale singleton with no matching open profile lock', () => {
    openFile = '/another/profile/Local Storage/leveldb/LOCK';
    expect(ownsLinuxProfile(42, profile)).toBe(false);
  });
  it('rejects another host and an unrelated process tree', () => {
    singleton = 'another-host-42';
    expect(ownsLinuxProfile(42, profile)).toBe(false);
    singleton = 'fixture-host-42';
    parent = 1;
    expect(ownsLinuxProfile(43, profile)).toBe(false);
  });
  it('rejects changing ownership during verification', () => {
    vi.mocked(fs.readlinkSync)
      .mockReturnValueOnce(singleton)
      .mockReturnValueOnce(openFile)
      .mockReturnValueOnce('fixture-host-99');
    expect(ownsLinuxProfile(42, profile)).toBe(false);
  });
});
