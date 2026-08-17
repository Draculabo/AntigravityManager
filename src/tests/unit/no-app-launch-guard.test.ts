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

  it('checks the command, not the arguments', () => {
    const result = spawnSync('echo', ['/mnt/c/Windows/fake.exe', 'antigravity']);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
  });
});
