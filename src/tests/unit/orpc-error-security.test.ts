import { readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

describe('ORPC public error details', () => {
  it('does not expose backend stacks outside development', () => {
    const routerSource = readFileSync(path.join(process.cwd(), 'src/ipc/router.ts'), 'utf-8');

    expect(routerSource).toContain("process.env.NODE_ENV === 'development'");
    expect(routerSource).toContain('backendStack: getPublicBackendStack(error)');
    expect(routerSource).not.toContain('backendStack: error.stack');
  });
});
