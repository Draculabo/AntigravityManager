import { readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

describe('preload sandbox compatibility', () => {
  it('does not import Node built-ins or initialize renderer Sentry directly', () => {
    const preloadSource = readFileSync(path.join(process.cwd(), 'src/preload.ts'), 'utf-8');

    expect(preloadSource).not.toMatch(/from ['"](fs|path|os)['"]/);
    expect(preloadSource).not.toContain('@sentry/electron/renderer');
    expect(preloadSource).not.toContain('SENTRY_ENABLED');
  });

  it('does not expose OAuth authorization codes to the renderer', () => {
    const preloadSource = readFileSync(path.join(process.cwd(), 'src/preload.ts'), 'utf-8');
    expect(preloadSource).not.toMatch(/onGoogleAuthCode|GOOGLE_AUTH_CODE/);
  });
});
