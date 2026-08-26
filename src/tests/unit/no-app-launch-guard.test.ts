import { execSync, spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

describe('no-app-launch guard', () => {
  it('refuses a command that looks like a Windows executable', () => {
    expect(() => execSync('/mnt/c/Windows/System32/cmd.exe /c echo hi')).toThrowError(
      /no-app-launch guard: refused child_process\.execSync/,
    );
  });

  it('refuses a command that names Antigravity itself', () => {
    expect(() => spawnSync('antigravity', ['--version'])).toThrowError(
      /no-app-launch guard: refused child_process\.spawnSync/,
    );
  });

  it('lets an ordinary command through untouched', () => {
    const output = execSync('echo hi').toString().trim();
    expect(output).toBe('hi');
  });

  it('refuses dangerous executable paths passed through command arguments', () => {
    expect(() => spawnSync('safe-test-runner', ['/mnt/c/Windows/fake.exe'])).toThrowError(
      /no-app-launch guard: refused child_process\.spawnSync/,
    );
  });

  it('refuses known application launchers even when their extension is omitted', () => {
    expect(() => spawnSync('cmd', ['/c', 'echo hi'])).toThrowError(
      /no-app-launch guard: refused child_process\.spawnSync/,
    );
  });
});
