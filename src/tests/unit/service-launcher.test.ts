import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { CoreStatus } from '@/core/core-service';
import { ServiceNotRunningError } from '@/core/management/client';
import { coreEnvironment, resolveCoreEntry, ServiceLauncher } from '@/cli/service-launcher';

const running: CoreStatus = {
  state: 'running',
  pid: 123,
  gateway: { running: true, port: 8045 },
};

function clock() {
  let time = 0;
  return {
    now: () => time,
    wait: async (milliseconds: number) => {
      time += milliseconds;
    },
  };
}

describe('ServiceLauncher', () => {
  it('preserves the Linux desktop session while excluding arbitrary secrets and Node injection', () => {
    expect(
      coreEnvironment({
        HOME: '/home/test',
        CLAUDE_CONFIG_DIR: '/fixture/claude',
        CODEX_HOME: '/fixture/codex',
        DISPLAY: ':0',
        WAYLAND_DISPLAY: 'wayland-0',
        DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
        XAUTHORITY: '/home/test/.Xauthority',
        API_TOKEN: 'fixture-secret',
        NODE_OPTIONS: '--require=fixture.cjs',
        NODE_PATH: '/fixture',
      }),
    ).toEqual({
      HOME: '/home/test',
      CLAUDE_CONFIG_DIR: '/fixture/claude',
      CODEX_HOME: '/fixture/codex',
      DISPLAY: ':0',
      WAYLAND_DISPLAY: 'wayland-0',
      DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
      XAUTHORITY: '/home/test/.Xauthority',
    });
  });
  it.each(['ECONNRESET', 'EPIPE'])(
    'observes %s during shutdown without replaying the request',
    async (code) => {
      const closing = Object.assign(new Error('closing management connection'), { code });
      const status = vi
        .fn<() => Promise<CoreStatus>>()
        .mockResolvedValueOnce(running)
        .mockRejectedValueOnce(closing)
        .mockRejectedValue(new ServiceNotRunningError());
      const shutdown = vi.fn(async () => {
        throw closing;
      });
      const launcher = new ServiceLauncher({
        management: { status, shutdown },
        probeProfileOwner: async () => null,
        launchCore: async () => {
          throw new Error('Unexpected launch');
        },
        ...clock(),
      });
      expect(await launcher.stop()).toEqual({ alreadyStopped: false });
      expect(shutdown).toHaveBeenCalledOnce();
      expect(status).toHaveBeenCalledTimes(3);
    },
  );
  it('resolves a sibling core artifact from the CLI entry', () => {
    expect(resolveCoreEntry(path.join('app', 'dist', 'cli', 'main.cjs'))).toBe(
      path.resolve('app', 'dist', 'core', 'main.cjs'),
    );
  });

  it('does not spawn when a core is already running', async () => {
    const launchCore = vi.fn();
    const launcher = new ServiceLauncher({
      management: { status: async () => running, shutdown: async () => {} },
      probeProfileOwner: async () => null,
      launchCore,
    });

    expect(await launcher.start()).toEqual({ status: running, alreadyRunning: true });
    expect(launchCore).not.toHaveBeenCalled();
  });

  it('starts a detached core and waits for readiness', async () => {
    const statuses = [null, { ...running, state: 'starting' as const }, running];
    const launchCore = vi.fn().mockResolvedValue({ hasExited: () => false });
    const launcher = new ServiceLauncher({
      probeProfileOwner: async () => null,
      management: {
        status: async () => {
          const status = statuses.shift();
          if (!status) {
            throw new ServiceNotRunningError();
          }
          return status;
        },
        shutdown: async () => {},
      },
      launchCore,
      ...clock(),
    });

    expect(await launcher.start()).toEqual({ status: running, alreadyRunning: false });
    expect(launchCore).toHaveBeenCalledOnce();
  });

  it('accepts a packaged cold start that becomes ready after 28 seconds', async () => {
    const time = clock();
    const launcher = new ServiceLauncher({
      probeProfileOwner: async () => null,
      management: {
        status: async () => {
          if (time.now() < 28_000) {
            throw new ServiceNotRunningError();
          }
          return running;
        },
        shutdown: async () => {},
      },
      launchCore: async () => ({ hasExited: () => false }),
      ...time,
    });

    expect(await launcher.start()).toEqual({ status: running, alreadyRunning: false });
  });

  it('reports early child exit and bounded startup timeout', async () => {
    const management = {
      status: async (): Promise<CoreStatus> => {
        throw new ServiceNotRunningError();
      },
      shutdown: async () => {},
    };
    const exited = new ServiceLauncher({
      management,
      probeProfileOwner: async () => null,
      launchCore: async () => ({ hasExited: () => true }),
      startupTimeoutMs: 200,
      ...clock(),
    });
    await expect(exited.start()).rejects.toThrow('exited before readiness');

    const slow = new ServiceLauncher({
      management,
      probeProfileOwner: async () => null,
      launchCore: async () => ({ hasExited: () => false }),
      startupTimeoutMs: 200,
      ...clock(),
    });
    await expect(slow.start()).rejects.toThrow('startup timed out');
  });

  it('lets concurrent starts converge on the same surviving core', async () => {
    let probes = 0;
    const launchCore = vi.fn().mockResolvedValue({ hasExited: () => true });
    const launcher = new ServiceLauncher({
      probeProfileOwner: async () => null,
      management: {
        status: async () => {
          probes += 1;
          if (probes < 5) {
            throw new ServiceNotRunningError();
          }
          return running;
        },
        shutdown: async () => {},
      },
      launchCore,
      ...clock(),
    });

    const results = await Promise.all([launcher.start(), launcher.start()]);
    expect(results.map((result) => result.status)).toEqual([running, running]);
    expect(launchCore).toHaveBeenCalledTimes(2);
  });

  it('treats absent service as stopped and waits for acknowledged shutdown', async () => {
    const absent = new ServiceLauncher({
      probeProfileOwner: async () => null,
      management: {
        status: async (): Promise<CoreStatus> => {
          throw new ServiceNotRunningError();
        },
        shutdown: async () => {},
      },
      launchCore: vi.fn(),
    });
    expect(await absent.stop()).toEqual({ alreadyStopped: true });

    let probes = 0;
    const shutdown = vi.fn().mockResolvedValue(undefined);
    const active = new ServiceLauncher({
      probeProfileOwner: async () => null,
      management: {
        status: async () => {
          probes += 1;
          if (probes > 2) {
            throw new ServiceNotRunningError();
          }
          return running;
        },
        shutdown,
      },
      launchCore: vi.fn(),
      ...clock(),
    });
    expect(await active.stop()).toEqual({ alreadyStopped: false });
    expect(shutdown).toHaveBeenCalledOnce();
  });

  it('rejects an acknowledgment when the service remains present', async () => {
    const launcher = new ServiceLauncher({
      management: { status: async () => running, shutdown: async () => {} },
      probeProfileOwner: async () => null,
      launchCore: vi.fn(),
      shutdownTimeoutMs: 200,
      ...clock(),
    });
    await expect(launcher.stop()).rejects.toThrow('did not stop before the deadline');
  });

  it('refuses to spawn while the desktop owns the profile', async () => {
    const launchCore = vi.fn();
    const launcher = new ServiceLauncher({
      management: {
        status: async (): Promise<CoreStatus> => {
          throw new ServiceNotRunningError();
        },
        shutdown: async () => {},
      },
      probeProfileOwner: async () => ({ version: 1, kind: 'desktop', pid: 456 }),
      launchCore,
    });

    await expect(launcher.start()).rejects.toThrow('desktop process 456');
    expect(launchCore).not.toHaveBeenCalled();
  });

  it('waits for an existing core owner to expose management readiness', async () => {
    let probes = 0;
    const launchCore = vi.fn();
    const launcher = new ServiceLauncher({
      management: {
        status: async () => {
          probes += 1;
          if (probes < 3) {
            throw new ServiceNotRunningError();
          }
          return running;
        },
        shutdown: async () => {},
      },
      probeProfileOwner: async () => ({ version: 1, kind: 'core', pid: 456 }),
      launchCore,
      ...clock(),
    });

    expect(await launcher.start()).toEqual({ status: running, alreadyRunning: true });
    expect(launchCore).not.toHaveBeenCalled();
  });
});
