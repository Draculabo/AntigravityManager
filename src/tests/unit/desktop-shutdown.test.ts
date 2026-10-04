import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDesktopShutdownCoordinator } from '@/modules/app-shell/services/desktop-shutdown';

describe('desktop shutdown coordinator', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('shares one request and drains warmups before stopping the gateway', async () => {
    const events: string[] = [];
    let finishDrain: () => void = () => {};
    const drain = new Promise<void>((resolve) => {
      finishDrain = resolve;
    });
    const shutdown = createDesktopShutdownCoordinator({
      stopMonitor: () => events.push('stop-monitor'),
      drainWarmups: () => {
        events.push('drain-warmups');
        return drain;
      },
      drainAccountSwitches: async () => {
        events.push('drain-switches');
      },
      stopAuth: async () => {
        events.push('stop-auth');
      },
      stopGateway: async () => {
        events.push('stop-gateway');
      },
      destroyTray: () => events.push('destroy-tray'),
      exit: () => events.push('exit'),
      warn: () => events.push('warn'),
    });

    const first = shutdown.request();
    const second = shutdown.request();
    expect(second).toBe(first);
    await Promise.resolve();
    expect(events).toEqual(['stop-monitor', 'drain-warmups', 'drain-switches', 'stop-auth']);

    finishDrain();
    await vi.waitFor(() => expect(events).toContain('destroy-tray'));
    expect(events).toEqual([
      'stop-monitor',
      'drain-warmups',
      'drain-switches',
      'stop-auth',
      'stop-gateway',
      'destroy-tray',
    ]);
    await vi.advanceTimersByTimeAsync(100);
    await first;
    expect(events.at(-1)).toBe('exit');
  });

  it('keeps the existing bounded exit when an in-flight warmup cannot drain', async () => {
    const warn = vi.fn();
    const exit = vi.fn();
    const stopGateway = vi.fn(async () => {});
    const shutdown = createDesktopShutdownCoordinator({
      stopMonitor: vi.fn(),
      drainWarmups: () => new Promise<void>(() => {}),
      drainAccountSwitches: vi.fn(async () => {}),
      stopAuth: vi.fn(async () => {}),
      stopGateway,
      destroyTray: vi.fn(),
      exit,
      warn,
    });

    const request = shutdown.request();
    await vi.advanceTimersByTimeAsync(3_100);
    await request;

    expect(warn).toHaveBeenCalledExactlyOnceWith(
      'Desktop shutdown cleanup timed out after 3000ms; forcing exit',
    );
    expect(stopGateway).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledOnce();
  });

  it('waits for OAuth enrollment before stopping the gateway', async () => {
    const events: string[] = [];
    let finishAuth: () => void = () => {};
    const auth = new Promise<void>((resolve) => {
      finishAuth = resolve;
    });
    const shutdown = createDesktopShutdownCoordinator({
      stopMonitor: () => events.push('stop-monitor'),
      drainWarmups: async () => {
        events.push('drain-warmups');
      },
      drainAccountSwitches: async () => {
        events.push('drain-switches');
      },
      stopAuth: () => {
        events.push('stop-auth');
        return auth;
      },
      stopGateway: async () => {
        events.push('stop-gateway');
      },
      destroyTray: () => events.push('destroy-tray'),
      exit: () => events.push('exit'),
      warn: () => events.push('warn'),
    });

    const request = shutdown.request();
    await Promise.resolve();
    await Promise.resolve();
    expect(events).toEqual(['stop-monitor', 'drain-warmups', 'drain-switches', 'stop-auth']);
    finishAuth();
    await vi.waitFor(() => expect(events).toContain('destroy-tray'));
    expect(events).toEqual([
      'stop-monitor',
      'drain-warmups',
      'drain-switches',
      'stop-auth',
      'stop-gateway',
      'destroy-tray',
    ]);
    await vi.advanceTimersByTimeAsync(100);
    await request;
  });
});
