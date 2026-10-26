import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DiagnosticMaintenanceScheduler } from '@/modules/proxy-gateway/diagnostics/maintenance-scheduler';

const reply = (moreWorkPending: boolean) => ({ databaseBytes: 100, moreWorkPending });
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('bounded audit maintenance scheduling', () => {
  it('can start with hourly maintenance only and continue a configuration backlog', async () => {
    const maintain = vi.fn().mockResolvedValue(reply(false));
    const scheduler = new DiagnosticMaintenanceScheduler(maintain, vi.fn());
    scheduler.start(false);
    expect(scheduler.state()).toBe('idle');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(maintain).not.toHaveBeenCalled();
    scheduler.continueFrom(reply(true));
    expect(scheduler.state()).toBe('scheduled');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(maintain).toHaveBeenCalledTimes(1);
    scheduler.stop();
    expect(scheduler.state()).toBe('stopped');
  });
  it('yields one second between successful backlog passes and retains the hourly interval', async () => {
    const maintain = vi.fn().mockResolvedValueOnce(reply(true)).mockResolvedValue(reply(false));
    const scheduler = new DiagnosticMaintenanceScheduler(maintain, vi.fn());
    scheduler.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(maintain).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(maintain).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(maintain).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(3_599_000);
    expect(maintain).toHaveBeenCalledTimes(3);
    scheduler.stop();
  });

  it('coalesces interval ticks while a pass is pending and cancels its continuation on stop', async () => {
    let finish!: (value: ReturnType<typeof reply>) => void;
    const maintain = vi.fn(
      () =>
        new Promise<ReturnType<typeof reply>>((resolve) => {
          finish = resolve;
        }),
    );
    const scheduler = new DiagnosticMaintenanceScheduler(maintain, vi.fn());
    scheduler.start();
    await vi.advanceTimersByTimeAsync(7_200_000);
    expect(maintain).toHaveBeenCalledTimes(1);
    scheduler.stop();
    finish(reply(true));
    await vi.advanceTimersByTimeAsync(7_200_000);
    expect(maintain).toHaveBeenCalledTimes(1);
  });

  it('reports failures without scheduling automatic retries', async () => {
    const error = new Error('synthetic maintenance failure');
    const maintain = vi.fn().mockRejectedValue(error);
    const failure = vi.fn();
    const scheduler = new DiagnosticMaintenanceScheduler(maintain, failure);
    scheduler.start();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(failure).toHaveBeenCalledWith(error);
    expect(maintain).toHaveBeenCalledTimes(1);
    scheduler.stop();
  });

  it('starts a fresh pass after a previous worker generation finishes', async () => {
    let finish!: (value: ReturnType<typeof reply>) => void;
    const maintain = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      )
      .mockResolvedValue(reply(false));
    const scheduler = new DiagnosticMaintenanceScheduler(maintain, vi.fn());
    scheduler.start();
    await vi.advanceTimersByTimeAsync(0);
    scheduler.stop();
    scheduler.start();
    finish(reply(true));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(maintain).toHaveBeenCalledTimes(2);
    scheduler.stop();
  });
});
