import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPackage } from '@electron/asar';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getAntigravityVersion,
  compareVersion,
  isCredentialStoreVersion,
} from '@/modules/antigravity-runtime/utils/antigravityVersion';
import { readWindowsFileVersion } from '@/modules/antigravity-runtime/utils/windowsFileVersion';

vi.mock('@/shared/platform/paths', () => ({
  getAntigravityExecutablePath: () => '/fixture/antigravity',
}));
vi.mock('@/modules/antigravity-runtime/utils/windowsFileVersion', () => ({
  readWindowsFileVersion: vi.fn(),
}));

const platform = process.platform;
beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  Object.defineProperty(process, 'platform', { value: platform });
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.resetModules();
});
function setPlatform(value: string) {
  Object.defineProperty(process, 'platform', { value });
}

describe('product version query', () => {
  it('reads and invalidates packed Linux metadata under standalone Node', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agm-packed-version-'));
    try {
      const source = path.join(directory, 'manifest');
      const resources = path.join(directory, 'resources');
      const archive = path.join(resources, 'app.asar');
      fs.mkdirSync(source);
      fs.mkdirSync(resources);
      fs.writeFileSync(
        path.join(source, 'package.json'),
        JSON.stringify({ name: 'antigravity', version: '2.19.1' }),
      );
      await createPackage(source, archive);
      setPlatform('linux');
      expect(await getAntigravityVersion('classic', path.join(directory, 'antigravity'))).toEqual({
        shortVersion: '2.19.1',
        bundleVersion: '2.19.1',
      });
      fs.writeFileSync(
        path.join(source, 'package.json'),
        JSON.stringify({ name: 'antigravity', version: '2.20.10' }),
      );
      await createPackage(source, archive);
      expect(await getAntigravityVersion('classic', path.join(directory, 'antigravity'))).toEqual({
        shortVersion: '2.20.10',
        bundleVersion: '2.20.10',
      });
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
  it('compares semver and retains the Classic 2.0 storage boundary', () => {
    expect(compareVersion('1.99.9', '2.0.0')).toBe(-1);
    expect(compareVersion('2.0.0', '2.0.0')).toBe(0);
    expect(compareVersion('2.18.1', '2.0.0')).toBe(1);
    expect(isCredentialStoreVersion({ shortVersion: '1.107.0', bundleVersion: '1.107.0' })).toBe(
      false,
    );
  });
  it('uses Win32 resource data and coalesces concurrent queries', async () => {
    setPlatform('win32');
    vi.mocked(readWindowsFileVersion).mockResolvedValue('2.18.1');
    vi.spyOn(fs, 'statSync').mockImplementation(() => {
      throw new Error('missing');
    });
    expect(
      await Promise.all([
        getAntigravityVersion('classic', '/fixture/a'),
        getAntigravityVersion('classic', '/fixture/a'),
      ]),
    ).toEqual([
      { shortVersion: '2.18.1', bundleVersion: '2.18.1' },
      { shortVersion: '2.18.1', bundleVersion: '2.18.1' },
    ]);
    expect(readWindowsFileVersion).toHaveBeenCalledOnce();
  });
  it('retries failures without permanent negative caching', async () => {
    setPlatform('win32');
    vi.mocked(readWindowsFileVersion)
      .mockRejectedValueOnce(new Error('resource missing'))
      .mockResolvedValueOnce('2.18.2');
    await expect(getAntigravityVersion('classic', '/fixture/retry')).rejects.toThrow(
      'resource missing',
    );
    expect(await getAntigravityVersion('classic', '/fixture/retry')).toEqual({
      shortVersion: '2.18.2',
      bundleVersion: '2.18.2',
    });
  });
  it('limits caller waiting while retaining an unfinished native probe', async () => {
    setPlatform('win32');
    vi.useFakeTimers();
    let complete!: (value: string) => void;
    vi.mocked(readWindowsFileVersion).mockReturnValue(
      new Promise((resolve) => {
        complete = resolve;
      }),
    );
    const query = getAntigravityVersion('classic', '/fixture/deadline');
    const rejection = expect(query).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(2500);
    await rejection;
    const second = getAntigravityVersion('classic', '/fixture/deadline');
    expect(readWindowsFileVersion).toHaveBeenCalledOnce();
    complete('2.18.1');
    expect(await second).toEqual({ shortVersion: '2.18.1', bundleVersion: '2.18.1' });
  });
  it('reads identified Linux installation metadata without running its executable', async () => {
    setPlatform('linux');
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    vi.spyOn(fs, 'readFileSync').mockReturnValue(
      JSON.stringify({ name: 'antigravity', version: '2.18.1' }),
    );
    expect(await getAntigravityVersion('classic', '/fixture/linux')).toEqual({
      shortVersion: '2.18.1',
      bundleVersion: '2.18.1',
    });
    expect(readWindowsFileVersion).not.toHaveBeenCalled();
  });
  it('rejects unrelated manifests instead of mistaking them for product versions', async () => {
    setPlatform('linux');
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    vi.spyOn(fs, 'readFileSync').mockReturnValue(
      JSON.stringify({ name: 'electron', version: '37.0.0' }),
    );
    await expect(getAntigravityVersion('classic', '/fixture/unrelated')).rejects.toThrow(
      'product version',
    );
  });
  it('refreshes a cached version after installation metadata changes', async () => {
    setPlatform('linux');
    const stat = fs.statSync(process.execPath);
    const spy = vi.spyOn(fs, 'statSync').mockReturnValue(stat);
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    const read = vi
      .spyOn(fs, 'readFileSync')
      .mockReturnValue(JSON.stringify({ name: 'antigravity', version: '2.18.1' }));
    await getAntigravityVersion('classic', '/fixture/update');
    spy.mockReturnValue({ ...stat, mtimeMs: stat.mtimeMs + 1000 });
    read.mockReturnValue(JSON.stringify({ name: 'antigravity', version: '2.18.2' }));
    expect((await getAntigravityVersion('classic', '/fixture/update')).shortVersion).toBe('2.18.2');
  });
  it('reads macOS product and bundle versions from its plist', async () => {
    setPlatform('darwin');
    vi.spyOn(fs, 'readFileSync').mockReturnValue(
      '<key>CFBundleShortVersionString</key><string>2.18.1</string><key>CFBundleVersion</key><string>123</string>',
    );
    expect(
      await getAntigravityVersion('ide', '/fixture/App.app/Contents/MacOS/Antigravity'),
    ).toEqual({ shortVersion: '2.18.1', bundleVersion: '123' });
  });
});
