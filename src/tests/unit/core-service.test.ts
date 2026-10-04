import { describe, expect, it, vi } from 'vitest';
import { CoreService, type CoreDependencies } from '@/core/core-service';
import { DEFAULT_APP_CONFIG } from '@/modules/config/types';

function createDependencies(autoStart: boolean): {
  dependencies: CoreDependencies;
  events: string[];
} {
  const events: string[] = [];
  const dependencies: CoreDependencies = {
    enableFileLogging: () => events.push('logging'),
    loadConfig: () => {
      events.push('config');
      return {
        ...DEFAULT_APP_CONFIG,
        proxy: { ...DEFAULT_APP_CONFIG.proxy, auto_start: autoStart },
      };
    },
    initializeAccounts: async () => {
      events.push('accounts');
    },
    initializeLocalDatabase: () => {
      events.push('database');
    },
    startGateway: async () => {
      events.push('gateway-start');
      return { success: true, port: 8045, base_url: 'http://127.0.0.1:8045' };
    },
    startGatewayOnPort: async (port) => {
      events.push('gateway-start-on-port');
      return { success: true, port, base_url: `http://127.0.0.1:${port}` };
    },
    stopGateway: async () => {
      events.push('gateway-stop');
      return true;
    },
    getGatewayStatus: async () => ({
      running: true,
      port: 8045,
      base_url: 'http://127.0.0.1:8045',
      active_accounts: 0,
    }),
  };
  return { dependencies, events };
}

describe('CoreService', () => {
  it('initializes persistence before starting an enabled gateway', async () => {
    const { dependencies, events } = createDependencies(true);
    const core = new CoreService(dependencies);

    await core.start();
    expect(events).toEqual(['logging', 'config', 'accounts', 'database', 'gateway-start']);
    expect(core.getStatus()).toEqual({
      state: 'running',
      pid: process.pid,
      gateway: { running: true, port: 8045 },
    });

    await core.stop();
    expect(events.at(-1)).toBe('gateway-stop');
    expect(core.getStatus().state).toBe('stopped');
  });

  it('keeps the gateway stopped when auto start is disabled', async () => {
    const { dependencies, events } = createDependencies(false);
    const core = new CoreService(dependencies);

    await core.start();
    expect(events).toEqual(['logging', 'config', 'accounts', 'database']);
    expect(core.getStatus().gateway).toEqual({ running: false, port: null });
    await core.stop();
  });

  it('preserves a startup failure even when cleanup also fails', async () => {
    const { dependencies } = createDependencies(true);
    const startupError = new Error('accounts unavailable');
    dependencies.initializeAccounts = vi.fn().mockRejectedValue(startupError);
    dependencies.stopGateway = vi.fn().mockRejectedValue(new Error('cleanup unavailable'));
    const core = new CoreService(dependencies);

    await expect(core.start()).rejects.toBe(startupError);
    expect(core.getStatus().state).toBe('stopped');
    expect(dependencies.stopGateway).toHaveBeenCalledOnce();
  });

  it('waits for account initialization before honoring shutdown', async () => {
    const { dependencies, events } = createDependencies(true);
    let releaseAccounts: (() => void) | undefined;
    const accountGate = new Promise<void>((resolve) => {
      releaseAccounts = resolve;
    });
    dependencies.initializeAccounts = async () => {
      events.push('accounts');
      await accountGate;
    };
    const core = new CoreService(dependencies);

    const started = core.start();
    expect(core.getStatus().state).toBe('starting');
    const stopped = core.stop();
    releaseAccounts?.();
    await Promise.all([started, stopped]);

    expect(events).toEqual([
      'logging',
      'config',
      'accounts',
      'database',
      'gateway-start',
      'gateway-stop',
    ]);
    expect(core.getStatus()).toEqual({
      state: 'stopped',
      pid: process.pid,
      gateway: { running: false, port: null },
    });
  });

  it('waits for gateway startup and stops it once for concurrent shutdown requests', async () => {
    const { dependencies, events } = createDependencies(true);
    let releaseGateway: (() => void) | undefined;
    const gatewayGate = new Promise<void>((resolve) => {
      releaseGateway = resolve;
    });
    dependencies.startGateway = async () => {
      events.push('gateway-start');
      await gatewayGate;
      return { success: true, port: 8045, base_url: 'http://127.0.0.1:8045' };
    };
    const core = new CoreService(dependencies);

    const started = core.start();
    await vi.waitFor(() => expect(events).toContain('gateway-start'));
    const stops = [core.stop(), core.stop()];
    releaseGateway?.();
    await Promise.all([started, ...stops]);

    expect(events.filter((event) => event === 'gateway-stop')).toEqual(['gateway-stop']);
    expect(core.getStatus().state).toBe('stopped');
  });

  it('can stop a later successful start after shutdown overlaps a failed start', async () => {
    const { dependencies, events } = createDependencies(true);
    let rejectAccounts: ((error: Error) => void) | undefined;
    const accountGate = new Promise<void>((_, reject) => {
      rejectAccounts = reject;
    });
    dependencies.initializeAccounts = vi
      .fn()
      .mockImplementationOnce(async () => accountGate)
      .mockResolvedValue(undefined);
    const core = new CoreService(dependencies);

    const failedStart = core.start();
    const firstStop = core.stop();
    rejectAccounts?.(new Error('initial account failure'));
    await expect(failedStart).rejects.toThrow('initial account failure');
    await firstStop;

    await core.start();
    await core.stop();
    expect(core.getStatus().state).toBe('stopped');
    expect(events.filter((event) => event === 'gateway-stop')).toEqual([
      'gateway-stop',
      'gateway-stop',
    ]);
  });

  it('keeps management gateway status aligned with remote lifecycle mutations', async () => {
    const { dependencies } = createDependencies(false);
    let runtimePort: number | null = null;
    dependencies.startGatewayOnPort = async (port) => {
      runtimePort = port;
      return { success: true, port, base_url: `http://localhost:${port}` };
    };
    dependencies.stopGateway = async () => {
      runtimePort = null;
      return true;
    };
    dependencies.getGatewayStatus = async () => ({
      running: runtimePort !== null,
      port: runtimePort ?? 0,
      base_url: runtimePort === null ? '' : `http://localhost:${runtimePort}`,
      active_accounts: 0,
    });
    const core = new CoreService(dependencies);
    await core.start();

    expect(await core.startGateway(8123)).toEqual({
      success: true,
      port: 8123,
      base_url: 'http://localhost:8123',
    });
    expect(core.getStatus().gateway).toEqual({ running: true, port: 8123 });
    expect(await core.stopGateway()).toBe(true);
    expect(core.getStatus().gateway).toEqual({ running: false, port: null });
    await core.stop();
  });

  it('drains an in-flight gateway mutation before core shutdown', async () => {
    const { dependencies, events } = createDependencies(false);
    let releaseStart: (() => void) | undefined;
    const startGate = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    let runtimePort: number | null = null;
    dependencies.startGatewayOnPort = async (port) => {
      events.push('remote-gateway-start');
      await startGate;
      runtimePort = port;
      return { success: true, port, base_url: `http://localhost:${port}` };
    };
    dependencies.stopGateway = async () => {
      events.push('gateway-stop');
      runtimePort = null;
      return true;
    };
    dependencies.getGatewayStatus = async () => ({
      running: runtimePort !== null,
      port: runtimePort ?? 0,
      base_url: runtimePort === null ? '' : `http://localhost:${runtimePort}`,
      active_accounts: 0,
    });
    const core = new CoreService(dependencies);
    await core.start();

    const starting = core.startGateway(8124);
    await vi.waitFor(() => expect(events).toContain('remote-gateway-start'));
    const stopping = core.stop();
    expect(core.getStatus().state).toBe('stopping');
    releaseStart?.();
    await Promise.all([starting, stopping]);

    expect(events.slice(-2)).toEqual(['remote-gateway-start', 'gateway-stop']);
    expect(core.getStatus().gateway).toEqual({ running: false, port: null });
  });
});
