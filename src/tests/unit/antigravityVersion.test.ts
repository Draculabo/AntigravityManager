import { afterEach, describe, it, expect, vi } from 'vitest';
import {
  compareVersion,
  isCredentialStoreVersion,
  isNewVersion,
} from '@/modules/antigravity-runtime/utils/antigravityVersion';

const originalPlatform = process.platform;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', {
    value: platform,
    configurable: true,
  });
}

interface VersionModuleMockOptions {
  platform: NodeJS.Platform;
  execPath?: string | null;
  execSync?: ReturnType<typeof vi.fn>;
  existsSync?: ReturnType<typeof vi.fn>;
  readFileSync?: ReturnType<typeof vi.fn>;
  /**
   * Whether the Linux this test describes is WSL. It defaults to false so the
   * Linux expectations below hold wherever the suite runs: on a real WSL host
   * the module takes the WSL branch instead, and a test asserting the plain
   * Linux answer would be asserting a branch it never reaches.
   */
  wsl?: boolean;
}

async function importVersionModule({
  platform,
  execPath = 'C:\\Program Files\\Antigravity\\Antigravity.exe',
  execSync = vi.fn(),
  existsSync = vi.fn(() => false),
  readFileSync = vi.fn(),
  wsl = false,
}: VersionModuleMockOptions) {
  vi.resetModules();
  setPlatform(platform);

  const getAntigravityExecutablePath = vi.fn(() => execPath);

  vi.doMock('child_process', () => ({
    execSync,
    default: {
      execSync,
    },
  }));
  vi.doMock('fs', () => ({
    existsSync,
    readFileSync,
    default: {
      existsSync,
      readFileSync,
    },
  }));
  vi.doMock('@/shared/platform/paths', () => ({
    getAntigravityExecutablePath,
    isWsl: () => wsl,
  }));
  vi.doMock('@/modules/account/types', () => ({
    resolveAntigravityAppTarget: (target: unknown) => target ?? 'stable',
  }));

  const module = await import('@/modules/antigravity-runtime/utils/antigravityVersion');

  return {
    module,
    getAntigravityExecutablePath,
  };
}

describe('antigravityVersion', () => {
  afterEach(() => {
    setPlatform(originalPlatform);
    vi.restoreAllMocks();
    vi.resetModules();
    vi.doUnmock('child_process');
    vi.doUnmock('fs');
    vi.doUnmock('@/shared/platform/paths');
    vi.doUnmock('@/modules/account/types');
  });

  it('reads the version from the manifest under WSL instead of launching the app', async () => {
    // Regression guard with a cost behind it: the resolved executable under WSL
    // is the Windows build, and running it does not print a version and exit --
    // the interop launch opens Antigravity on the user's desktop. Once per
    // version lookup, which a test run does repeatedly.
    const execSync = vi.fn(() => {
      throw new Error('the executable must not be run under WSL');
    });
    const execPath = '/mnt/c/Users/alice/AppData/Local/Programs/Antigravity/Antigravity.exe';
    const existsSync = vi.fn((candidate: unknown) => String(candidate).endsWith('package.json'));
    const readFileSync = vi.fn(() => JSON.stringify({ version: '1.19.3' }));

    const { module } = await importVersionModule({
      platform: 'linux',
      wsl: true,
      execPath,
      execSync,
      existsSync,
      readFileSync,
    });

    expect(module.getAntigravityVersion()).toEqual({
      shortVersion: '1.19.3',
      bundleVersion: '1.19.3',
    });
    expect(execSync).not.toHaveBeenCalled();
  });

  it('should compare versions correctly', () => {
    expect(compareVersion('1.16.5', '1.16.4')).toBe(1);
    expect(compareVersion('1.16.5', '1.16.5')).toBe(0);
    expect(compareVersion('1.16.4', '1.16.5')).toBe(-1);
    expect(compareVersion('1.17.0', '1.16.5')).toBe(1);
    expect(compareVersion('2.0.0', '1.16.5')).toBe(1);
  });

  it('should compare semver and raw executable version strings', () => {
    expect(compareVersion('2.0.0-beta.1', '2.0.0')).toBe(-1);
    expect(compareVersion('v2.0.0', '2.0.0')).toBe(0);
    expect(compareVersion('Antigravity 2.0.1', '2.0.0')).toBe(1);
    expect(compareVersion('1.16.5.0', '1.16.5')).toBe(0);
    expect(compareVersion('unknown', '1.16.5')).toBe(-1);
    expect(compareVersion('1.16.5', 'invalid')).toBe(1);
    expect(compareVersion('unknown', 'invalid')).toBe(0);
  });

  it('should detect new version >= 1.16.5', () => {
    expect(isNewVersion({ shortVersion: '1.16.4', bundleVersion: '1.16.4' })).toBe(false);
    expect(isNewVersion({ shortVersion: '1.16.5', bundleVersion: '1.16.5' })).toBe(true);
    expect(isNewVersion({ shortVersion: '1.17.0', bundleVersion: '1.17.0' })).toBe(true);
  });

  it('should identify credential-store Antigravity versions', () => {
    expect(isCredentialStoreVersion({ shortVersion: '1.99.9', bundleVersion: '1.99.9' })).toBe(
      false,
    );
    expect(isCredentialStoreVersion({ shortVersion: '2.0.0', bundleVersion: '2.0.0' })).toBe(true);
    expect(isCredentialStoreVersion({ shortVersion: '4.2.0', bundleVersion: '4.2.0' })).toBe(true);
  });

  it('should read and cache the Windows executable file version', async () => {
    const execSync = vi.fn(() => ' 2.0.1 \n');
    const { module } = await importVersionModule({
      platform: 'win32',
      execPath: "C:\\O'Brien\\Antigravity.exe",
      execSync,
    });

    const version = module.getAntigravityVersion();
    const cached = module.getAntigravityVersion();

    expect(version).toEqual({
      shortVersion: '2.0.1',
      bundleVersion: '2.0.1',
    });
    expect(cached).toBe(version);
    expect(execSync).toHaveBeenCalledTimes(1);
    expect(execSync).toHaveBeenCalledWith(
      expect.stringContaining("C:\\O''Brien\\Antigravity.exe"),
      expect.any(Object),
    );
  });

  it('should fallback to package.json on Windows when version detection fails', async () => {
    const execSync = vi.fn(() => {
      throw new Error('ps fail');
    });
    const existsSync = vi.fn(() => true);
    const readFileSync = vi.fn(() => JSON.stringify({ version: '1.16.6' }));
    const { module } = await importVersionModule({
      platform: 'win32',
      execSync,
      existsSync,
      readFileSync,
    });

    const version = module.getAntigravityVersion();
    const cached = module.getAntigravityVersion();

    expect(version.shortVersion).toBe('1.16.6');
    expect(cached.shortVersion).toBe('1.16.6');
    expect(execSync).toHaveBeenCalledTimes(1);
  });

  it('should rethrow the Windows detection error when package fallback is unavailable', async () => {
    const execSync = vi.fn(() => {
      throw new Error('ps fail');
    });
    const { module } = await importVersionModule({
      platform: 'win32',
      execSync,
    });

    expect(() => module.getAntigravityVersion()).toThrow('ps fail');
  });

  it('should normalize non-error Windows detection failures', async () => {
    const execSync = vi.fn(() => {
      throw 'ps fail';
    });
    const { module } = await importVersionModule({
      platform: 'win32',
      execSync,
    });

    expect(() => module.getAntigravityVersion()).toThrow('Unable to determine Antigravity version');
  });

  it('should reject empty Windows executable versions', async () => {
    const execSync = vi.fn(() => '\n');
    const { module } = await importVersionModule({
      platform: 'win32',
      execSync,
    });

    expect(() => module.getAntigravityVersion()).toThrow('Version information not found');
  });

  it('should cache executable lookup errors', async () => {
    const { module, getAntigravityExecutablePath } = await importVersionModule({
      platform: 'win32',
      execPath: null,
    });

    expect(() => module.getAntigravityVersion()).toThrow('Unable to locate Antigravity executable');
    expect(() => module.getAntigravityVersion()).toThrow('Unable to locate Antigravity executable');
    expect(getAntigravityExecutablePath).toHaveBeenCalledTimes(1);
  });

  it('should read macOS plist versions', async () => {
    const plist = `
      <plist>
        <dict>
          <key>CFBundleShortVersionString</key>
          <string>2.1.0</string>
          <key>CFBundleVersion</key>
          <string>20260201</string>
        </dict>
      </plist>
    `;
    const { module } = await importVersionModule({
      platform: 'darwin',
      execPath: '/Applications/Antigravity.app/Contents/MacOS/Antigravity',
      existsSync: vi.fn(() => true),
      readFileSync: vi.fn(() => plist),
    });

    expect(module.getAntigravityVersion()).toEqual({
      shortVersion: '2.1.0',
      bundleVersion: '20260201',
    });
  });

  it('should read macOS plist versions when the executable path is already the app path', async () => {
    const plist = `
      <plist>
        <dict>
          <key>CFBundleShortVersionString</key>
          <string>2.1.1</string>
        </dict>
      </plist>
    `;
    const { module } = await importVersionModule({
      platform: 'darwin',
      execPath: '/Applications/Antigravity',
      existsSync: vi.fn(() => true),
      readFileSync: vi.fn(() => plist),
    });

    expect(module.getAntigravityVersion()).toEqual({
      shortVersion: '2.1.1',
      bundleVersion: '2.1.1',
    });
  });

  it('should convert binary macOS plists before reading versions', async () => {
    const execSync = vi.fn(
      () => `
        <plist>
          <dict>
            <key>CFBundleShortVersionString</key>
            <string>2.2.0</string>
          </dict>
        </plist>
      `,
    );
    const { module } = await importVersionModule({
      platform: 'darwin',
      execPath: '/Applications/Antigravity.app/Contents/MacOS/Antigravity',
      execSync,
      existsSync: vi.fn(() => true),
      readFileSync: vi.fn(() => 'bplist00'),
    });

    expect(module.getAntigravityVersion()).toEqual({
      shortVersion: '2.2.0',
      bundleVersion: '2.2.0',
    });
    expect(execSync).toHaveBeenCalledWith(expect.stringContaining('plutil'), expect.any(Object));
  });

  it('should report macOS plist read failures', async () => {
    const { module } = await importVersionModule({
      platform: 'darwin',
      execPath: '/Applications/Antigravity.app/Contents/MacOS/Antigravity',
      existsSync: vi.fn(() => false),
    });

    expect(() => module.getAntigravityVersion()).toThrow('Info.plist not found');
  });

  it('should report binary macOS plist conversion failures', async () => {
    const execSync = vi.fn(() => {
      throw new Error('plutil fail');
    });
    const { module } = await importVersionModule({
      platform: 'darwin',
      execSync,
      existsSync: vi.fn(() => true),
      readFileSync: vi.fn(() => 'bplist00'),
    });

    expect(() => module.getAntigravityVersion()).toThrow('Failed to parse Info.plist');
  });

  it('should read Linux CLI versions', async () => {
    const execSync = vi.fn(() => '2.3.0\n');
    const { module } = await importVersionModule({
      platform: 'linux',
      execPath: '/opt/antigravity/antigravity',
      execSync,
    });

    expect(module.getAntigravityVersion()).toEqual({
      shortVersion: '2.3.0',
      bundleVersion: '2.3.0',
    });
    expect(execSync).toHaveBeenCalledWith(
      '"/opt/antigravity/antigravity" --version',
      expect.any(Object),
    );
  });

  it('should fallback to package.json on Linux when CLI detection fails', async () => {
    const execSync = vi.fn(() => {
      throw new Error('cli fail');
    });
    const { module } = await importVersionModule({
      platform: 'linux',
      execPath: '/opt/antigravity/antigravity',
      execSync,
      existsSync: vi.fn(() => true),
      readFileSync: vi.fn(() => JSON.stringify({ version: '2.4.0' })),
    });

    expect(module.getAntigravityVersion()).toEqual({
      shortVersion: '2.4.0',
      bundleVersion: '2.4.0',
    });
  });

  it('should report unsupported platforms and invalid package fallback versions', async () => {
    const { module } = await importVersionModule({
      platform: 'aix',
      execPath: '/opt/antigravity/antigravity',
    });

    expect(() => module.getAntigravityVersion()).toThrow('Unable to determine Antigravity version');

    const { module: invalidFallbackModule } = await importVersionModule({
      platform: 'linux',
      execSync: vi.fn(() => {
        throw new Error('cli fail');
      }),
      existsSync: vi.fn(() => true),
      readFileSync: vi.fn(() => JSON.stringify({ version: '   ' })),
    });

    expect(() => invalidFallbackModule.getAntigravityVersion()).toThrow(
      'Unable to determine Antigravity version',
    );
  });
});
