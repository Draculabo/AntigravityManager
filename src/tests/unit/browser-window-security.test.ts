import { readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

describe('BrowserWindow security settings', () => {
  it('keeps renderer sandboxed with Node integration disabled', () => {
    const mainSource = readFileSync(path.join(process.cwd(), 'src/main.ts'), 'utf-8');

    expect(mainSource).toContain('sandbox: true');
    expect(mainSource).toContain('contextIsolation: true');
    expect(mainSource).toContain('nodeIntegration: false');
  });

  it('does not allow unsafe eval in the renderer content security policy', () => {
    const indexHtml = readFileSync(path.join(process.cwd(), 'index.html'), 'utf-8');

    expect(indexHtml).toContain('Content-Security-Policy');
    expect(indexHtml).not.toContain('unsafe-eval');
  });
});
