import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const authServerSource = fs.readFileSync(
  path.join(process.cwd(), 'src/modules/cloud-account/ipc/authServer.ts'),
  'utf-8',
);

describe('OAuth callback loopback address', () => {
  it('uses the same explicit IPv4 loopback address for binding and redirect URIs', () => {
    expect(authServerSource).toContain("const OAUTH_LOOPBACK_HOST = '127.0.0.1';");
    expect(authServerSource).toContain('testServer.listen(port, OAUTH_LOOPBACK_HOST');
    expect(authServerSource).toContain('this.server.listen(this.PORT, OAUTH_LOOPBACK_HOST');
    expect(authServerSource).toContain(
      'return `http://${OAUTH_LOOPBACK_HOST}:${this.PORT}/oauth-callback`;',
    );
  });

  it('does not advertise localhost while binding only an IPv4 loopback listener', () => {
    expect(authServerSource).not.toContain('http://localhost:${this.PORT}/oauth-callback');
  });
});
