import { readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

describe('BrowserWindow security settings', () => {
  it('uses the same unsandboxed renderer model as Folo for Windows compatibility', () => {
    const mainSource = readFileSync(path.join(process.cwd(), 'src/main.ts'), 'utf-8');

    expect(mainSource).toContain('sandbox: false');
    expect(mainSource).toContain('webviewTag: true');
    expect(mainSource).toContain('webSecurity: !inDevelopment');
    expect(mainSource).toContain('contextIsolation: false');
    expect(mainSource).toContain('nodeIntegration: true');
  });

  it('does not allow unsafe eval in the renderer content security policy', () => {
    const indexHtml = readFileSync(path.join(process.cwd(), 'index.html'), 'utf-8');

    expect(indexHtml).toContain('Content-Security-Policy');
    expect(indexHtml).not.toContain('unsafe-eval');
  });

  it('does not use no-sandbox or Windows GPU startup switches as the compatibility fix', () => {
    const mainSource = readFileSync(path.join(process.cwd(), 'src/main.ts'), 'utf-8');
    const gpuSwitchesSource = readFileSync(
      path.join(process.cwd(), 'src/modules/app-shell/utils/startupGpuSwitches.ts'),
      'utf-8',
    );

    expect(mainSource).toContain('applyStartupGpuSwitches');
    expect(gpuSwitchesSource).toContain("if (platform === 'linux')");
    expect(mainSource).not.toContain("app.commandLine.appendSwitch('no-sandbox')");
    expect(mainSource).not.toMatch(
      /process\.platform === 'linux' \|\| process\.platform === 'win32'/,
    );
  });
});
