import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_APP_CONFIG } from '@/modules/config/types';
import { bootstrapNestServer, getNestServerStatus, stopNestServer } from '@/server/main';

const { mockAttachResponsesWebSocketServer, mockCreate, mockLogger } = vi.hoisted(() => ({
  mockAttachResponsesWebSocketServer: vi.fn(() => vi.fn()),
  mockCreate: vi.fn(),
  mockLogger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('@nestjs/core', () => ({
  NestFactory: {
    create: mockCreate,
  },
}));

vi.mock('@nestjs/platform-fastify', () => ({
  FastifyAdapter: vi.fn(),
}));

vi.mock('@/shared/logging/logger', () => ({
  logger: mockLogger,
}));

vi.mock(
  '@/modules/proxy-gateway/server/modules/openai/responses/openai-responses-websocket.server',
  () => ({
    attachOpenAIResponsesWebSocketServer: mockAttachResponsesWebSocketServer,
  }),
);

describe('gateway server startup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await stopNestServer();
  });

  it('reports EADDRINUSE as an expected startup failure and cleans up the server', async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    const listen = vi.fn().mockRejectedValue(
      Object.assign(new Error('listen EADDRINUSE: address already in use 127.0.0.1:8045'), {
        code: 'EADDRINUSE',
      }),
    );
    mockCreate.mockResolvedValue({
      register: vi.fn().mockResolvedValue(undefined),
      enableCors: vi.fn(),
      listen,
      close,
    });

    const result = await bootstrapNestServer(DEFAULT_APP_CONFIG.proxy);

    expect(result).toEqual({
      success: false,
      reason: 'address-in-use',
      port: 8045,
      message: 'Port 8045 is already in use',
    });
    expect(listen).toHaveBeenCalledWith(8045, '127.0.0.1');
    expect(close).toHaveBeenCalledTimes(1);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      'NestJS Proxy Server could not start: Port 8045 is already in use',
      expect.any(Error),
    );
    expect(mockLogger.error).not.toHaveBeenCalledWith(
      'Failed to start NestJS server',
      expect.anything(),
    );

    await expect(getNestServerStatus()).resolves.toMatchObject({
      running: false,
      port: 0,
      base_url: '',
    });
  });

  it('keeps an open gateway on loopback without browser CORS access', async () => {
    const listen = vi.fn().mockResolvedValue(undefined);
    const enableCors = vi.fn();
    mockCreate.mockResolvedValue({
      register: vi.fn().mockResolvedValue(undefined),
      enableCors,
      listen,
      close: vi.fn().mockResolvedValue(undefined),
      get: vi.fn(() => ({
        getAccountCount: () => 0,
      })),
      getHttpServer: vi.fn(() => ({})),
    });

    const result = await bootstrapNestServer({
      ...DEFAULT_APP_CONFIG.proxy,
      port: 8123,
    });

    expect(result).toEqual({
      success: true,
      port: 8123,
      base_url: 'http://localhost:8123',
    });
    expect(listen).toHaveBeenCalledWith(8123, '127.0.0.1');
    expect(enableCors).not.toHaveBeenCalled();
    expect(mockAttachResponsesWebSocketServer).toHaveBeenCalledOnce();

    await expect(getNestServerStatus()).resolves.toMatchObject({
      running: true,
      port: 8123,
      base_url: 'http://localhost:8123',
    });
  });

  it('allows LAN binding only when an API key is configured', async () => {
    const listen = vi.fn().mockResolvedValue(undefined);
    const enableCors = vi.fn();
    mockCreate.mockResolvedValue({
      register: vi.fn().mockResolvedValue(undefined),
      enableCors,
      listen,
      close: vi.fn().mockResolvedValue(undefined),
      get: vi.fn(() => ({
        getAccountCount: () => 0,
      })),
      getHttpServer: vi.fn(() => ({})),
    });

    await expect(
      bootstrapNestServer({
        ...DEFAULT_APP_CONFIG.proxy,
        port: 8124,
        api_key: 'test-api-key',
      }),
    ).resolves.toMatchObject({ success: true, port: 8124 });

    expect(listen).toHaveBeenCalledWith(8124, '0.0.0.0');
    expect(enableCors).toHaveBeenCalledOnce();
  });
});
