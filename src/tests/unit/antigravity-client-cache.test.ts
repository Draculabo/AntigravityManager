import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/shared/logging/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

const originalPlatform = process.platform;
const originalLocalAppData = process.env.LOCALAPPDATA;
const originalAppData = process.env.APPDATA;
const originalXdgCacheHome = process.env.XDG_CACHE_HOME;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', {
    value: platform,
    configurable: true,
  });
}

describe('Antigravity client cache', () => {
  let tempDir: string;

  beforeEach(() => {
    vi.resetModules();
    setPlatform('win32');
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-client-cache-'));
    process.env.LOCALAPPDATA = path.join(tempDir, 'Local');
    process.env.APPDATA = path.join(tempDir, 'Roaming');
  });

  afterEach(() => {
    setPlatform(originalPlatform);
    process.env.LOCALAPPDATA = originalLocalAppData;
    process.env.APPDATA = originalAppData;
    process.env.XDG_CACHE_HOME = originalXdgCacheHome;
    fs.rmSync(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('lists existing Windows IDE cache paths in priority order', async () => {
    const localIdeCache = path.win32.join(process.env.LOCALAPPDATA!, 'Antigravity IDE', 'Cache');
    const roamingIdeCache = path.win32.join(process.env.APPDATA!, 'Antigravity IDE', 'Cache');
    fs.mkdirSync(localIdeCache, { recursive: true });
    fs.mkdirSync(roamingIdeCache, { recursive: true });
  });

  it('preserves the Windows cache candidate priority order', async () => {
    const { getAntigravityClientCachePaths } =
      await import('@/modules/antigravity-runtime/cache/antigravityClientCache');

    expect(getAntigravityClientCachePaths()).toEqual([
      path.win32.join(process.env.LOCALAPPDATA!, 'Google', 'Antigravity'),
      path.win32.join(process.env.LOCALAPPDATA!, 'Antigravity', 'Cache'),
      path.win32.join(process.env.LOCALAPPDATA!, 'Antigravity IDE', 'Cache'),
      path.win32.join(process.env.APPDATA!, 'Antigravity', 'Cache'),
      path.win32.join(process.env.APPDATA!, 'Antigravity IDE', 'Cache'),
    ]);
  });

  it('preserves the Linux cache candidate priority order', async () => {
    setPlatform('linux');
    vi.spyOn(os, 'homedir').mockReturnValue(tempDir);
    process.env.XDG_CACHE_HOME = path.join(tempDir, 'xdg-cache');
    const { getAntigravityClientCachePaths } =
      await import('@/modules/antigravity-runtime/cache/antigravityClientCache');

    expect(getAntigravityClientCachePaths()).toEqual([
      path.posix.join(tempDir, '.cache', 'Antigravity'),
      path.posix.join(tempDir, '.cache', 'google-antigravity'),
      path.posix.join(tempDir, '.antigravity'),
      path.posix.join(process.env.XDG_CACHE_HOME, 'Antigravity'),
      path.posix.join(process.env.XDG_CACHE_HOME, 'google-antigravity'),
    ]);
  });

  it('preserves the macOS cache candidate priority order', async () => {
    setPlatform('darwin');
    vi.spyOn(os, 'homedir').mockReturnValue(tempDir);
    const { getAntigravityClientCachePaths } =
      await import('@/modules/antigravity-runtime/cache/antigravityClientCache');

    expect(getAntigravityClientCachePaths()).toEqual([
      path.posix.join(tempDir, 'Library', 'HTTPStorages', 'com.google.antigravity'),
      path.posix.join(tempDir, 'Library', 'Caches', 'com.google.antigravity'),
      path.posix.join(tempDir, '.antigravity'),
      path.posix.join(tempDir, '.config', 'antigravity'),
    ]);
  });

  it('removes an existing cache directory and reports the freed bytes', async () => {
    const localIdeCache = path.win32.join(process.env.LOCALAPPDATA!, 'Antigravity IDE', 'Cache');
    const nestedCache = path.win32.join(localIdeCache, 'Code Cache');
    fs.mkdirSync(nestedCache, { recursive: true });
    fs.writeFileSync(path.win32.join(localIdeCache, 'index'), 'cache');
    fs.writeFileSync(path.win32.join(nestedCache, 'entry'), 'payload');

    const { clearAntigravityClientCache } =
      await import('@/modules/antigravity-runtime/cache/antigravityClientCache');
    const result = clearAntigravityClientCache();

    expect(result).toEqual({
      clearedPaths: [localIdeCache],
      totalSizeFreed: Buffer.byteLength('cache') + Buffer.byteLength('payload'),
      errors: [],
    });
    expect(fs.existsSync(localIdeCache)).toBe(false);
  });

  it('continues clearing later paths when one cache directory fails', async () => {
    const localClassicCache = path.win32.join(process.env.LOCALAPPDATA!, 'Antigravity', 'Cache');
    const localIdeCache = path.win32.join(process.env.LOCALAPPDATA!, 'Antigravity IDE', 'Cache');
    fs.mkdirSync(localClassicCache, { recursive: true });
    fs.mkdirSync(localIdeCache, { recursive: true });
    fs.writeFileSync(path.win32.join(localClassicCache, 'locked'), 'lock');
    fs.writeFileSync(path.win32.join(localIdeCache, 'entry'), 'cache');

    const originalRmSync = fs.rmSync.bind(fs);
    vi.spyOn(fs, 'rmSync').mockImplementation((targetPath, options) => {
      if (String(targetPath) === localClassicCache) {
        throw new Error('locked');
      }
      originalRmSync(targetPath, options);
    });

    const { clearAntigravityClientCache } =
      await import('@/modules/antigravity-runtime/cache/antigravityClientCache');
    const result = clearAntigravityClientCache();

    expect(result).toEqual({
      clearedPaths: [localIdeCache],
      totalSizeFreed: Buffer.byteLength('cache'),
      errors: [`Failed to remove ${localClassicCache}: locked`],
    });
    expect(fs.existsSync(localClassicCache)).toBe(true);
    expect(fs.existsSync(localIdeCache)).toBe(false);
  });
});
