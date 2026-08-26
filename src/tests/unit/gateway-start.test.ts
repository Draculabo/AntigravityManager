import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_APP_CONFIG } from '@/modules/config/types';
import { bootstrapNestServer, getNestServerStatus, stopNestServer } from '@/server/main';

const { mockAddContentTypeParser, mockAttachResponsesWebSocketServer, mockCreate, mockLogger } =
  vi.hoisted(() => ({
    mockAddContentTypeParser: vi.fn(),
    mockAttachResponsesWebSocketServer: vi.fn(() => vi.fn()),
    mockCreate: vi.fn(),
    mockLogger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  }));

vi.mock('@nestjs/core', async (importOriginal) => ({
  // Keep the real tokens: the module graph under test registers providers against
  // APP_INTERCEPTOR, and a mock that only carries NestFactory makes importing it fail.
  ...(await importOriginal<typeof import('@nestjs/core')>()),
  NestFactory: {
    create: mockCreate,
  },
  // `GeminiController` reflects `ModuleRef` as a constructor parameter type
  // (to resolve `BatchRunnerService` lazily without a circular module import;
  // see `gemini.controller.ts`), so decorator metadata evaluation needs a
  // real export here even though this test never constructs the controller.
  ModuleRef: class ModuleRef {},
}));

vi.mock('@nestjs/platform-fastify', () => ({
  FastifyAdapter: class {
    getInstance() {
      return { addContentTypeParser: mockAddContentTypeParser };
    }
  },
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
      Object.assign(new Error('listen EADDRINUSE: address already in use 0.0.0.0:8045'), {
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

  it('returns the actual configured port when startup succeeds', async () => {
    const listen = vi.fn().mockResolvedValue(undefined);
    mockCreate.mockResolvedValue({
      register: vi.fn().mockResolvedValue(undefined),
      enableCors: vi.fn(),
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
    expect(listen).toHaveBeenCalledWith(8123, '0.0.0.0');
    expect(mockAttachResponsesWebSocketServer).toHaveBeenCalledOnce();
    // The raw media parser is what makes Google's simple file upload possible,
    // and it only applies to media families so no existing route changes.
    expect(mockAddContentTypeParser).toHaveBeenCalledWith(
      expect.any(RegExp),
      expect.objectContaining({ parseAs: 'buffer' }),
      expect.any(Function),
    );
    expect(mockAddContentTypeParser.mock.calls[0][0].test('application/json')).toBe(true);
    expect(mockAddContentTypeParser.mock.calls[0][0].test('multipart/form-data')).toBe(false);

    await expect(getNestServerStatus()).resolves.toMatchObject({
      running: true,
      port: 8123,
      base_url: 'http://localhost:8123',
    });
  });
});
