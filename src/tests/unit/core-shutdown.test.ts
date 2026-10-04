import { describe, expect, it, vi } from 'vitest';
import { createCoreShutdown } from '@/core/shutdown';

describe('core shutdown', () => {
  it('waits for terminal diagnostics even with no running gateway before releasing ownership', async () => {
    const events: string[] = [];
    let finish: () => void = () => {};
    const drained = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const shutdown = createCoreShutdown({
      management: {
        close: async () => {
          events.push('management');
        },
      },
      core: {
        stop: async () => {
          events.push('core');
        },
      },
      diagnostics: {
        shutdown: async () => {
          events.push('diagnostics');
          await drained;
        },
      },
      lease: {
        close: async () => {
          events.push('lease');
        },
      },
    });
    const closing = shutdown();
    await vi.waitFor(() => expect(events).toEqual(['management', 'core', 'diagnostics']));
    finish();
    await closing;
    expect(events).toEqual(['management', 'core', 'diagnostics', 'lease']);
  });

  it('retains ownership and reports terminal diagnostic failure', async () => {
    const failure = new Error('diagnostic worker still running');
    const diagnostics = { shutdown: vi.fn().mockRejectedValue(failure) };
    const lease = { close: vi.fn() };
    const shutdown = createCoreShutdown({
      management: { close: async () => {} },
      core: { stop: async () => {} },
      diagnostics,
      lease,
    });
    await expect(shutdown()).rejects.toThrow('Core shutdown failed');
    await expect(shutdown()).rejects.toThrow('Core shutdown failed');
    expect(diagnostics.shutdown).toHaveBeenCalledOnce();
    expect(lease.close).not.toHaveBeenCalled();
  });
  it('stops the core when management closure fails', async () => {
    const failure = new Error('management close failed');
    const management = { close: vi.fn().mockRejectedValue(failure) };
    const core = { stop: vi.fn().mockResolvedValue(undefined) };
    const shutdown = createCoreShutdown({ management, core });

    await expect(shutdown()).rejects.toThrow(AggregateError);
    expect(management.close).toHaveBeenCalledOnce();
    expect(core.stop).toHaveBeenCalledOnce();
    await expect(shutdown()).rejects.toThrow(AggregateError);
    expect(core.stop).toHaveBeenCalledOnce();
  });

  it('releases the profile only after the core stops', async () => {
    const events: string[] = [];
    const shutdown = createCoreShutdown({
      management: {
        close: async () => {
          events.push('management');
        },
      },
      core: {
        stop: async () => {
          events.push('core');
        },
      },
      lease: {
        close: async () => {
          events.push('lease');
        },
      },
    });

    await shutdown();
    expect(events).toEqual(['management', 'core', 'lease']);
  });

  it('keeps ownership when the core cannot stop', async () => {
    const lease = { close: vi.fn() };
    const shutdown = createCoreShutdown({
      management: { close: async () => {} },
      core: {
        stop: async () => {
          throw new Error('gateway still running');
        },
      },
      lease,
    });

    await expect(shutdown()).rejects.toThrow(AggregateError);
    expect(lease.close).not.toHaveBeenCalled();
  });

  it('closes OAuth before releasing profile ownership', async () => {
    const events: string[] = [];
    const shutdown = createCoreShutdown({
      oauth: {
        stop: async () => {
          events.push('oauth');
        },
      },
      management: {
        close: async () => {
          events.push('management');
        },
      },
      core: {
        stop: async () => {
          events.push('core');
        },
      },
      lease: {
        close: async () => {
          events.push('lease');
        },
      },
    });

    await shutdown();
    expect(events[0]).toBe('oauth');
    expect(events.at(-1)).toBe('lease');
  });

  it('stops RPC admission and drains management before stopping persistence', async () => {
    let finishManagementClose: (() => void) | undefined;
    const managementClose = new Promise<void>((resolve) => {
      finishManagementClose = resolve;
    });
    const events: string[] = [];
    const shutdown = createCoreShutdown({
      management: {
        beginShutdown: () => events.push('admission-closed'),
        close: async () => {
          events.push('management-closing');
          await managementClose;
          events.push('management-closed');
        },
      },
      core: {
        stop: async () => {
          events.push('core-stopped');
        },
      },
      lease: {
        close: async () => {
          events.push('lease-released');
        },
      },
    });

    const stopping = shutdown();
    expect(events).toEqual(['admission-closed', 'management-closing']);
    finishManagementClose?.();
    await stopping;
    expect(events).toEqual([
      'admission-closed',
      'management-closing',
      'management-closed',
      'core-stopped',
      'lease-released',
    ]);
  });

  it('cancels and drains warmups after RPC admission closes and before core stop', async () => {
    const events: string[] = [];
    let finishWarmup: () => void = () => {};
    const warmupDrain = new Promise<void>((resolve) => {
      finishWarmup = resolve;
    });
    const shutdown = createCoreShutdown({
      management: {
        beginShutdown: () => events.push('admission-closed'),
        close: async () => {
          events.push('management-closed');
        },
      },
      accountMutations: {
        closeAccountMutationAdmission: () => events.push('account-admission-closed'),
        drainAccountMutations: async () => {
          events.push('account-work-drained');
        },
      },
      warmup: {
        cancel: () => events.push('warmup-cancelled'),
        drain: async () => {
          events.push('warmup-draining');
          await warmupDrain;
          events.push('warmup-drained');
        },
      },
      core: {
        stop: async () => {
          events.push('core-stopped');
        },
      },
    });

    const first = shutdown();
    const second = shutdown();
    await vi.waitFor(() => expect(events).toContain('warmup-draining'));
    expect(events).toEqual([
      'admission-closed',
      'account-admission-closed',
      'warmup-cancelled',
      'management-closed',
      'account-work-drained',
      'warmup-draining',
    ]);
    finishWarmup();
    await Promise.all([first, second]);
    expect(events).toEqual([
      'admission-closed',
      'account-admission-closed',
      'warmup-cancelled',
      'management-closed',
      'account-work-drained',
      'warmup-draining',
      'warmup-drained',
      'core-stopped',
    ]);
  });
});
