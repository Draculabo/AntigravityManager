import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ agentDir: '/home/test/.antigravity-agent' }));

vi.mock('@/shared/platform/paths', () => ({
  getAgentDir: () => fixture.agentDir,
}));

import { bindLocalEndpoint, getLocalEndpoint } from '@/core/local-endpoint';

describe('local endpoints', () => {
  it('keeps the profile endpoint compact for long Linux home paths', () => {
    fixture.agentDir =
      '/home/draculabo/.cache/agm-switch-close-20261113/homes/classic/.antigravity-agent';

    const endpoint = getLocalEndpoint('profile-owner-v1', 'linux');

    expect(endpoint.length).toBeLessThanOrEqual(100);
    expect(endpoint).toMatch(
      /antigravity-manager[\\/]agm-[0-9a-f]{16}[\\/]profile-owner-v1\.sock$/,
    );
  });

  it.skipIf(process.platform === 'win32')(
    'binds a long-profile endpoint through the Unix socket boundary',
    async () => {
      fixture.agentDir =
        '/home/draculabo/.cache/agm-switch-close-20261113/homes/classic/.antigravity-agent';
      const endpoint = getLocalEndpoint('core-v1', 'linux');
      const server = net.createServer();

      try {
        await bindLocalEndpoint(
          endpoint,
          'linux',
          () =>
            new Promise<void>((resolve, reject) => {
              server.once('error', reject);
              server.listen(endpoint, () => {
                server.off('error', reject);
                resolve();
              });
            }),
        );
        expect(server.listening).toBe(true);
      } finally {
        await new Promise<void>((resolve) => {
          if (!server.listening) {
            resolve();
            return;
          }
          server.close(() => resolve());
        });
        await fs.rm(path.dirname(endpoint), { recursive: true, force: true });
      }
    },
  );

  it('keeps the existing profile-local endpoint for ordinary paths', () => {
    fixture.agentDir = '/home/draculabo/.antigravity-agent';

    expect(getLocalEndpoint('core-v1', 'linux').replaceAll('\\', '/')).toBe(
      '/home/draculabo/.antigravity-agent/runtime/core-v1.sock',
    );
  });
});
