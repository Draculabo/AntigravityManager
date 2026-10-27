import { describe, expect, it } from 'vitest';
import { isTargetAntigravityProcessCandidate } from '@/shared/platform/paths';
import { isAntigravityHelperProcess } from '@/shared/platform/antigravityProcessIdentity';

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

describe('client executable identity', () => {
  it.each([
    'antigravity-hans-gui.exe',
    'antigravity-patch.exe',
    'notepad.exe',
    'antigravity-ide-patch.exe',
  ])('does not identify %s from its name, directory or arguments', (name) => {
    const executablePath = `C:\\Antigravity IDE\\${name}`;
    for (const target of ['classic', 'ide'] as const) {
      expect(
        isTargetAntigravityProcessCandidate(
          { name, executablePath, commandLine: `"${executablePath}" --target Antigravity` },
          target,
          { ignoreExecutableConfiguration: true },
        ),
      ).toBe(false);
    }
  });
  it.each([
    ['Antigravity.exe', 'classic'],
    ['antigravity', 'classic'],
    ['Antigravity IDE.exe', 'ide'],
    ['antigravity-ide', 'ide'],
    ['antigravity_ide.exe', 'ide'],
  ] as const)('recognizes the exact %s binary', (name, target) => {
    const executablePath = `C:\\Apps\\${name}`;
    expect(
      isTargetAntigravityProcessCandidate(
        { name, executablePath, commandLine: `"${executablePath}"` },
        target,
        { ignoreExecutableConfiguration: true },
      ),
    ).toBe(true);
  });
});

describe('engine role identity', () => {
  it.each(['--standalone', '--subclient_type', '--override_ide_name'])(
    '%s is never a main process',
    (flag) => {
      for (const args of [[flag, 'ide'], [`${flag}=ide`]]) {
        expect(isAntigravityHelperProcess('Antigravity.exe', args)).toBe(true);
        expect(
          isTargetAntigravityProcessCandidate(
            {
              name: 'Antigravity.exe',
              executablePath: 'C:\\Apps\\Antigravity.exe',
              commandLine: `C:\\Apps\\Antigravity.exe ${args.join(' ')}`,
            },
            'classic',
            { ignoreExecutableConfiguration: true },
          ),
        ).toBe(false);
      }
    },
  );
  it('does not interpret flag text inside ordinary argument values as a role', () => {
    expect(
      isAntigravityHelperProcess('Antigravity.exe', [
        '--folder=C:\\work\\--standalone',
        'my--subclient_type.txt',
      ]),
    ).toBe(false);
  });
});
