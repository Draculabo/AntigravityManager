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

import { startGateway } from '@/modules/proxy-gateway/ipc/handlers';

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
});
