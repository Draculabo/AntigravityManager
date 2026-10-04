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
    try {
      const entry = path.resolve('package.json');
      const launched = await launchDetachedCore(entry);
      expect(mocks.spawn).toHaveBeenCalledWith(
        process.execPath,
        [entry],
        expect.objectContaining({ detached: true, stdio: 'ignore', windowsHide: true }),
      );
      const options = mocks.spawn.mock.calls[0][2] as { env: NodeJS.ProcessEnv };
      expect(options.env.AGM_TEST_SECRET).toBeUndefined();
      expect(child.unref).toHaveBeenCalledOnce();
      expect(launched.hasExited()).toBe(false);
      child.exitCode = 1;
      expect(launched.hasExited()).toBe(true);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
