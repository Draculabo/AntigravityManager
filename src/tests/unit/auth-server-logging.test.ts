import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

describe('OAuth callback logging', () => {
  it('does not include authorization code material in log messages', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'src/modules/cloud-account/ipc/authServer.ts'),
      'utf-8',
    );

    expect(source).toContain("logger.info('AuthServer: Received authorization code');");
    expect(source).not.toContain('escapedCode.substring');
    expect(source).not.toMatch(/Received authorization code:\s*\$\{/);
  });
});
