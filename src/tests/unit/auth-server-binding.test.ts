import { readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

describe('OAuth callback server port binding', () => {
  it('binds the real callback server before accepting a fallback port', () => {
    const source = readFileSync(
      path.join(process.cwd(), 'src/modules/cloud-account/ipc/authServer.ts'),
      'utf-8',
    );

    expect(source).toContain('const server = await this.bind(port);');
    expect(source).toContain('this.server = server;');
    expect(source).not.toContain('const testServer = http.createServer();');
  });
});
