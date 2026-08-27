import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockBootstrapNestServer, mockLoadConfig, mockStopNestServer } = vi.hoisted(() => ({
  mockBootstrapNestServer: vi.fn(),
  mockLoadConfig: vi.fn(() => ({
    proxy: {
      api_key: '',
      port: 8045,
    },
  })),
  mockStopNestServer: vi.fn(),
}));

vi.mock('@/server/main', () => ({
  bootstrapNestServer: mockBootstrapNestServer,
  getNestServerStatus: vi.fn(),
  stopNestServer: mockStopNestServer,
}));

vi.mock('@/modules/config/ipc/manager', () => ({
  ConfigManager: {
    loadConfig: mockLoadConfig,
    saveConfig: vi.fn(),
  },
}));

vi.mock('@/shared/logging/logger', () => ({
  logger: {
    error: vi.fn(),
  },
}));

vi.mock('@/modules/proxy-gateway/server/modules/gemini/explicit-context-cache.store', () => ({
  explicitContextCacheManager: {
    getStats: vi.fn(() => ({})),
  },
}));

import { startGateway, stopGateway } from '@/modules/proxy-gateway/ipc/handlers';

describe('gateway lifecycle serialization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadConfig.mockReturnValue({
      proxy: {
        api_key: '',
        port: 8045,
      },
    });
    mockBootstrapNestServer.mockImplementation(async (config: { port: number }) => ({
      success: true,
      port: config.port,
      base_url: `http://localhost:${config.port}`,
    }));
  });

  it('serializes concurrent gateway starts across stop and bootstrap', async () => {
    let releaseFirstStop!: (value: boolean) => void;
    const firstStop = new Promise<boolean>((resolve) => {
      releaseFirstStop = resolve;
    });
    mockStopNestServer.mockReturnValueOnce(firstStop).mockResolvedValue(true);

    const firstStart = startGateway(8045);
    const secondStart = startGateway(8123);

    await vi.waitFor(() => {
      expect(mockStopNestServer).toHaveBeenCalledTimes(1);
    });
    expect(mockBootstrapNestServer).not.toHaveBeenCalled();

    releaseFirstStop(true);

    await expect(firstStart).resolves.toMatchObject({ success: true, port: 8045 });
    await expect(secondStart).resolves.toMatchObject({ success: true, port: 8123 });

    expect(mockStopNestServer).toHaveBeenCalledTimes(2);
    expect(mockBootstrapNestServer).toHaveBeenCalledTimes(2);
    expect(mockBootstrapNestServer.mock.calls[0]?.[0]).toMatchObject({ port: 8045 });
    expect(mockBootstrapNestServer.mock.calls[1]?.[0]).toMatchObject({ port: 8123 });
  });

  it('queues a stop until the active start has completed', async () => {
    let releaseBootstrap!: (value: { success: true; port: number; base_url: string }) => void;
    const firstBootstrap = new Promise<{ success: true; port: number; base_url: string }>(
      (resolve) => {
        releaseBootstrap = resolve;
      },
    );
    mockStopNestServer.mockResolvedValue(true);
    mockBootstrapNestServer.mockReturnValueOnce(firstBootstrap);

    const start = startGateway(8045);
    await vi.waitFor(() => {
      expect(mockBootstrapNestServer).toHaveBeenCalledTimes(1);
    });

    const stop = stopGateway();
    expect(mockStopNestServer).toHaveBeenCalledTimes(1);

    releaseBootstrap({ success: true, port: 8045, base_url: 'http://localhost:8045' });

    await expect(start).resolves.toMatchObject({ success: true, port: 8045 });
    await expect(stop).resolves.toBe(true);
    expect(mockStopNestServer).toHaveBeenCalledTimes(2);
  });

  it('releases the queue after a failed start', async () => {
    mockStopNestServer.mockResolvedValue(true);
    mockBootstrapNestServer
      .mockRejectedValueOnce(new Error('bind failed'))
      .mockResolvedValueOnce({ success: true, port: 8123, base_url: 'http://localhost:8123' });

    const failedStart = startGateway(8045);
    const succeedingStart = startGateway(8123);

    await expect(failedStart).resolves.toMatchObject({ success: false, port: 8045 });
    await expect(succeedingStart).resolves.toMatchObject({ success: true, port: 8123 });
    expect(mockStopNestServer).toHaveBeenCalledTimes(2);
    expect(mockBootstrapNestServer).toHaveBeenCalledTimes(2);
  });
});
