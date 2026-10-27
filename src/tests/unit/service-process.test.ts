import { EventEmitter } from 'node:events';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', () => ({
  default: { spawn: mocks.spawn },
  spawn: mocks.spawn,
}));

import { launchDetachedCore } from '@/cli/service-launcher';

describe('detached core process', () => {
  it('uses Node, detaches the child and does not forward arbitrary environment values', async () => {
    const child = new EventEmitter() as EventEmitter & {
      exitCode: number | null;
      signalCode: NodeJS.Signals | null;
      unref: ReturnType<typeof vi.fn>;
    };
    child.exitCode = null;
    child.signalCode = null;
    child.unref = vi.fn();
    mocks.spawn.mockImplementation(() => {
      queueMicrotask(() => child.emit('spawn'));
      return child;
    });
    vi.stubEnv('AGM_TEST_SECRET', 'must-not-be-forwarded');
    vi.stubEnv('HTTP_PROXY', 'http://127.0.0.1:17891');
    vi.stubEnv('HTTPS_PROXY', 'http://127.0.0.1:17892');
    vi.stubEnv('ALL_PROXY', 'socks5://127.0.0.1:17893');
    vi.stubEnv('NO_PROXY', 'localhost,127.0.0.1,::1');
    vi.stubEnv('NODE_OPTIONS', '--require=forbidden-fixture.cjs');
    vi.stubEnv('NODE_PATH', '/forbidden-fixture');
    try {
      const entry = path.resolve('package.json');
      const launched = await launchDetachedCore(entry);
      expect(mocks.spawn).toHaveBeenCalledWith(
        process.execPath,
        [entry],
        expect.objectContaining({ detached: true, stdio: 'ignore', windowsHide: true }),
      );
      const options = mocks.spawn.mock.calls[0][2] as { env: NodeJS.ProcessEnv };
      expect({
        HTTP_PROXY: options.env.HTTP_PROXY,
        HTTPS_PROXY: options.env.HTTPS_PROXY,
        ALL_PROXY: options.env.ALL_PROXY,
        NO_PROXY: options.env.NO_PROXY,
        AGM_TEST_SECRET: options.env.AGM_TEST_SECRET,
        NODE_OPTIONS: options.env.NODE_OPTIONS,
        NODE_PATH: options.env.NODE_PATH,
      }).toEqual({
        HTTP_PROXY: 'http://127.0.0.1:17891',
        HTTPS_PROXY: 'http://127.0.0.1:17892',
        ALL_PROXY: 'socks5://127.0.0.1:17893',
        NO_PROXY: 'localhost,127.0.0.1,::1',
        AGM_TEST_SECRET: undefined,
        NODE_OPTIONS: undefined,
        NODE_PATH: undefined,
      });
      expect(child.unref).toHaveBeenCalledOnce();
      expect(launched.hasExited()).toBe(false);
      child.exitCode = 1;
      expect(launched.hasExited()).toBe(true);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
