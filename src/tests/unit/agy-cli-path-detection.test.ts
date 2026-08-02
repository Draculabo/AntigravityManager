import { describe, expect, it } from 'vitest';
import { detectAgyCliExecutablePath } from '@/modules/antigravity-runtime/binary-patch/agyCliPathDetection';

function createExists(...existingPaths: string[]) {
  const paths = new Set(existingPaths);
  return (candidatePath: string) => paths.has(candidatePath);
}

describe('agy CLI path detection', () => {
  it('returns the configured executable before probing standard locations', () => {
    const configuredPath = '/configured/agy';

    expect(
      detectAgyCliExecutablePath({
        configuredPath,
        exists: createExists(configuredPath, '/home/user/.local/bin/agy'),
        homeDirectory: '/home/user',
        pathEnvironment: '/usr/local/bin:/usr/bin',
        platform: 'linux',
      }),
    ).toBe(configuredPath);
  });

  it('truly bypasses the configured executable during a forced detection', () => {
    const localExecutablePath = '/home/user/.local/bin/agy';

    expect(
      detectAgyCliExecutablePath({
        bypassConfig: true,
        configuredPath: '/configured/agy',
        exists: createExists('/configured/agy', localExecutablePath),
        homeDirectory: '/home/user',
        pathEnvironment: '/usr/local/bin:/usr/bin',
        platform: 'linux',
      }),
    ).toBe(localExecutablePath);
  });

  it('prefers the standard user-local executable over PATH', () => {
    const localExecutablePath = '/home/user/.local/bin/agy';

    expect(
      detectAgyCliExecutablePath({
        exists: createExists(localExecutablePath, '/usr/local/bin/agy'),
        homeDirectory: '/home/user',
        pathEnvironment: '/usr/local/bin:/usr/bin',
        platform: 'linux',
      }),
    ).toBe(localExecutablePath);
  });

  it('finds the first executable in PATH when the user-local path is absent', () => {
    expect(
      detectAgyCliExecutablePath({
        exists: createExists('/opt/agy/bin/agy', '/usr/local/bin/agy'),
        homeDirectory: '/home/user',
        pathEnvironment: '/opt/agy/bin:/usr/local/bin:/usr/bin',
        platform: 'linux',
      }),
    ).toBe('/opt/agy/bin/agy');
  });

  it('uses agy.exe and the Windows PATH delimiter on Windows', () => {
    expect(
      detectAgyCliExecutablePath({
        exists: createExists('D:\\Agy\\bin\\agy.exe'),
        homeDirectory: 'C:\\Users\\test',
        pathEnvironment: 'C:\\Tools;D:\\Agy\\bin;C:\\Windows',
        platform: 'win32',
      }),
    ).toBe('D:\\Agy\\bin\\agy.exe');
  });

  it('returns null when no CLI executable can be found', () => {
    expect(
      detectAgyCliExecutablePath({
        exists: () => false,
        homeDirectory: '/home/user',
        pathEnvironment: '/usr/local/bin:/usr/bin',
        platform: 'darwin',
      }),
    ).toBeNull();
  });
});
