import { describe, expect, it } from 'vitest';
import { isTargetAntigravityProcessCandidate } from '@/shared/platform/paths';

describe('Windows installer process identity', () => {
  it.each([
    ['Antigravity-x64.exe', 'classic'],
    ['Antigravity-arm64.exe', 'classic'],
    ['AntigravitySetup-x64-1.20.0.exe', 'classic'],
    ['Antigravity IDE-x64.exe', 'ide'],
    ['Antigravity-ide-arm64.exe', 'ide'],
  ] as const)('excludes %s from %s process discovery', (name, target) => {
    expect(
      isTargetAntigravityProcessCandidate(
        {
          name,
          executablePath: `C:\\Downloads\\${name}`,
          commandLine: `"C:\\Downloads\\${name}"`,
        },
        target,
        { ignoreExecutableConfiguration: true },
      ),
    ).toBe(false);
  });
});
