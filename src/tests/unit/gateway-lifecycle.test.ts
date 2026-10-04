import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_APP_CONFIG } from '@/modules/config/types';
import { GatewayLifecycleService } from '@/modules/proxy-gateway/services/gateway-lifecycle.service';

describe('GatewayLifecycleService', () => {
  it('serializes gateway restarts and stop without overlapping the server', async () => {
    const events: string[] = [];
    let finishFirstStart: (() => void) | undefined;
    const firstStart = new Promise<void>((resolve) => {
      finishFirstStart = resolve;
    });
    const lifecycle = new GatewayLifecycleService({
      loadConfig: () => DEFAULT_APP_CONFIG.proxy,
      stop: async () => {
        events.push('stop');
        return true;
      },
      start: async (config) => {
        events.push(`start:${config.port}`);
        if (config.port === 8045) {
          await firstStart;
        }
        return {
          success: true,
          port: config.port,
          base_url: `http://localhost:${config.port}`,
        };
      },
    });

    const first = lifecycle.start(8045);
    const second = lifecycle.start(8046);
    const stopped = lifecycle.stop();
    await vi.waitFor(() => expect(events).toEqual(['stop', 'start:8045']));
    finishFirstStart?.();

    expect(await Promise.all([first, second, stopped])).toEqual([
      { success: true, port: 8045, base_url: 'http://localhost:8045' },
      { success: true, port: 8046, base_url: 'http://localhost:8046' },
      true,
    ]);
    expect(events).toEqual(['stop', 'start:8045', 'stop', 'start:8046', 'stop']);
  });

  it('does not start another server when the previous one cannot stop', async () => {
    const start = vi.fn();
    const lifecycle = new GatewayLifecycleService({
      loadConfig: () => DEFAULT_APP_CONFIG.proxy,
      stop: async () => false,
      start,
    });

    expect(await lifecycle.start(8046)).toEqual({
      success: false,
      reason: 'unknown',
      port: 8046,
      message: 'Failed to stop gateway before restart',
    });
    expect(start).not.toHaveBeenCalled();
  });
});
