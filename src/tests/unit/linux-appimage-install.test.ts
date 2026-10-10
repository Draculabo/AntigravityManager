// @vitest-environment node
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const electron = vi.hoisted(() => ({ app: { isPackaged: true } }));
const filesystem = vi.hoisted(() => ({ blockedPath: '' }));
vi.mock('electron', () => electron);
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const accessSync = (file: fs.PathLike, mode?: number) => {
    if (file === filesystem.blockedPath) {
      throw new Error('EACCES');
    }
    actual.accessSync(file, mode);
  };
  return {
    ...actual,
    accessSync,
    default: { ...actual, accessSync },
  };
});
import { getAppImageInstallTarget } from '@/modules/app-shell/update/linuxAppImageInstall';

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
const arch = Object.getOwnPropertyDescriptor(process, 'arch')!;
let directory: string;
let target: string;

beforeEach(() => {
  Object.defineProperty(process, 'platform', { value: 'linux' });
  Object.defineProperty(process, 'arch', { value: 'x64' });
  electron.app.isPackaged = true;
  filesystem.blockedPath = '';
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agm-appimage-selection-'));
  target = path.join(directory, 'Manager.AppImage');
  const header = Buffer.alloc(32);
  Buffer.from([0x7f, 0x45, 0x4c, 0x46]).copy(header);
  header[4] = 2;
  header[5] = 1;
  Buffer.from([0x41, 0x49, 0x02]).copy(header, 8);
  header.writeUInt16LE(62, 18);
  fs.writeFileSync(target, header);
  vi.stubEnv('APPIMAGE', target);
});

afterEach(() => {
  Object.defineProperty(process, 'platform', platform);
  Object.defineProperty(process, 'arch', arch);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  fs.rmSync(directory, { recursive: true, force: true });
});

describe('AppImage installation selection', () => {
  it.each(['x64', 'arm64'])('accepts a writable packaged type-2 archive on %s', (value) => {
    Object.defineProperty(process, 'arch', { value });
    const header = fs.readFileSync(target);
    header.writeUInt16LE(value === 'x64' ? 62 : 183, 18);
    fs.writeFileSync(target, header);
    expect(getAppImageInstallTarget()).toBe(target);
  });

  it('rejects an archive for another CPU architecture', () => {
    const header = fs.readFileSync(target);
    header.writeUInt16LE(183, 18);
    fs.writeFileSync(target, header);
    expect(getAppImageInstallTarget()).toBeNull();
  });

  it.each(['win32', 'darwin'])('rejects an AppImage environment on %s', (value) => {
    Object.defineProperty(process, 'platform', { value });
    expect(getAppImageInstallTarget()).toBeNull();
  });

  it('rejects unpacked builds and unsupported architectures', () => {
    electron.app.isPackaged = false;
    expect(getAppImageInstallTarget()).toBeNull();
    electron.app.isPackaged = true;
    Object.defineProperty(process, 'arch', { value: 'ia32' });
    expect(getAppImageInstallTarget()).toBeNull();
  });

  it.each(['', 'relative.AppImage', 'invalid\0path'])(
    'rejects an invalid runtime path %j',
    (value) => {
      vi.stubEnv('APPIMAGE', value);
      expect(getAppImageInstallTarget()).toBeNull();
    },
  );

  it('rejects missing files, directories and ordinary ELF executables', () => {
    fs.unlinkSync(target);
    expect(getAppImageInstallTarget()).toBeNull();
    fs.mkdirSync(target);
    expect(getAppImageInstallTarget()).toBeNull();
    fs.rmdirSync(target);
    fs.writeFileSync(target, Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 0, 0, 0, 0, 0, 0]));
    expect(getAppImageInstallTarget()).toBeNull();
  });

  it('rejects a forged AppImage marker without an ELF header', () => {
    fs.writeFileSync(target, Buffer.from([0, 0, 0, 0, 0, 0, 0, 0, 0x41, 0x49, 2]));
    expect(getAppImageInstallTarget()).toBeNull();
  });

  it.each(['archive', 'directory'])('rejects a non-writable %s before downloading', (location) => {
    filesystem.blockedPath = location === 'archive' ? target : directory;
    expect(getAppImageInstallTarget()).toBeNull();
  });
});
