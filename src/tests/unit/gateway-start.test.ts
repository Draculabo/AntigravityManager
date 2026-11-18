import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_APP_CONFIG } from '@/modules/config/types';
import {
  bootstrapNestServer,
  forgetDeletedNestServerAccount,
  getNestServerStatus,
  stopNestServer,
} from '@/server/main';
import { AccountLeaseService } from '@/server/gateway/modules/account-lease/account-lease.service';
import { GeminiClient } from '@/server/gateway/modules/gemini/gemini-client.service';
import { proxyModelAvailabilityStore } from '@/server/gateway/shared/services/model-availability.service';
import { trafficAuditService } from '@/modules/proxy-gateway/audit/traffic-audit.service';
import { thoughtStoreService } from '@/modules/proxy-gateway/thought-store/thought-store.service';

const {
  mockAddContentTypeParser,
  mockAddHook,
  mockAttachResponsesWebSocketServer,
  mockCreate,
  mockLogger,
} = vi.hoisted(() => ({
  mockAddContentTypeParser: vi.fn(),
  mockAddHook: vi.fn(),
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
      return { addContentTypeParser: mockAddContentTypeParser, addHook: mockAddHook };
    }
  },
}));

vi.mock('@/shared/logging/logger', () => ({
  logger: mockLogger,
}));

vi.mock(
  '@/server/gateway/modules/openai/responses/openai-responses-websocket.server',
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
    vi.restoreAllMocks();
  });

  it.each(['none', 'client', 'lease', 'both'] as const)(
    'forgets deleted-account recovery and lease state even when cleanup fails: %s',
    async (mode) => {
      const clientFailure = new Error('synthetic client cleanup failure');
      const leaseFailure = new Error('synthetic lease cleanup failure');
      const client = {
        forgetDeletedAccount: vi.fn(() => {
          if (mode === 'client' || mode === 'both') {
            throw clientFailure;
          }
        }),
      };
      const lease = {
        getAccountCount: () => 0,
        forgetDeletedAccount: vi.fn(() => {
          if (mode === 'lease' || mode === 'both') {
            throw leaseFailure;
          }
        }),
      };
      mockCreate.mockResolvedValue({
        register: vi.fn().mockResolvedValue(undefined),
        getHttpAdapter: vi.fn(() => ({ getInstance: () => ({ addHook: mockAddHook }) })),
        enableCors: vi.fn(),
        listen: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
        get: vi.fn((token) =>
          token === GeminiClient ? client : token === AccountLeaseService ? lease : {},
        ),
        getHttpServer: vi.fn(() => ({})),
      });
      vi.spyOn(trafficAuditService, 'close').mockResolvedValue();
      vi.spyOn(thoughtStoreService, 'close').mockResolvedValue();
      expect((await bootstrapNestServer(DEFAULT_APP_CONFIG.proxy)).success).toBe(true);
      let failure: unknown;
      try {
        forgetDeletedNestServerAccount('synthetic-deleted-account');
      } catch (error) {
        failure = error;
      }
      expect(client.forgetDeletedAccount).toHaveBeenCalledExactlyOnceWith(
        'synthetic-deleted-account',
      );
      expect(lease.forgetDeletedAccount).toHaveBeenCalledExactlyOnceWith(
        'synthetic-deleted-account',
      );
      if (mode === 'both') {
        expect(failure).toBeInstanceOf(AggregateError);
        expect(failure).toMatchObject({
          errors: [clientFailure, leaseFailure],
          cause: clientFailure,
        });
      } else {
        expect(failure).toBe(
          mode === 'client' ? clientFailure : mode === 'lease' ? leaseFailure : undefined,
        );
      }
    },
  );

  it('keeps stopped-gateway account deletion on the existing availability cleanup path', () => {
    const clear = vi
      .spyOn(proxyModelAvailabilityStore, 'clearAccountOrThrow')
      .mockImplementation(() => {});
    forgetDeletedNestServerAccount('synthetic-stopped-account');
    expect(clear).toHaveBeenCalledExactlyOnceWith('synthetic-stopped-account');
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('reports diagnostic close failure while still attempting both stores', async () => {
    mockCreate.mockResolvedValue({
      register: vi.fn().mockResolvedValue(undefined),
      getHttpAdapter: vi.fn(() => ({ getInstance: () => ({ addHook: mockAddHook }) })),
      enableCors: vi.fn(),
      listen: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      get: vi.fn(() => ({ getAccountCount: () => 0 })),
      getHttpServer: vi.fn(() => ({})),
    });
    const auditClose = vi
      .spyOn(trafficAuditService, 'close')
      .mockRejectedValueOnce(new Error('worker did not close'));
    const thoughtClose = vi.spyOn(thoughtStoreService, 'close').mockResolvedValue(undefined);
    expect((await bootstrapNestServer(DEFAULT_APP_CONFIG.proxy)).success).toBe(true);
    await expect(stopNestServer()).resolves.toBe(false);
    expect(auditClose).toHaveBeenCalledOnce();
    expect(thoughtClose).toHaveBeenCalledOnce();
    expect(mockLogger.error).toHaveBeenCalledWith(
      'Failed to stop NestJS server',
      expect.any(AggregateError),
    );
  });

  it('closes diagnostic stores even when Nest shutdown fails', async () => {
    const close = vi
      .fn()
      .mockRejectedValueOnce(new Error('pending token write'))
      .mockResolvedValue(undefined);
    mockCreate.mockResolvedValue({
      register: vi.fn().mockResolvedValue(undefined),
      enableCors: vi.fn(),
      listen: vi.fn().mockResolvedValue(undefined),
      close,
      get: vi.fn(() => ({ getAccountCount: () => 0 })),
      getHttpServer: vi.fn(() => ({})),
    });
    const auditClose = vi.spyOn(trafficAuditService, 'close').mockResolvedValue(undefined);
    const thoughtClose = vi.spyOn(thoughtStoreService, 'close').mockResolvedValue(undefined);
    expect((await bootstrapNestServer(DEFAULT_APP_CONFIG.proxy)).success).toBe(true);
    await expect(stopNestServer()).resolves.toBe(false);
    expect(auditClose).toHaveBeenCalledOnce();
    expect(thoughtClose).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
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
      getHttpAdapter: vi.fn(() => ({ getInstance: () => ({ addHook: mockAddHook }) })),
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
      getHttpAdapter: vi.fn(() => ({ getInstance: () => ({ addHook: mockAddHook }) })),
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
      listen_address: '127.0.0.1',
    });
    expect(listen).toHaveBeenCalledWith(8123, '127.0.0.1');
    expect(enableCors).not.toHaveBeenCalled();
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

  it('allows explicit LAN binding when an API key is configured', async () => {
    const listen = vi.fn().mockResolvedValue(undefined);
    const enableCors = vi.fn();
    mockCreate.mockResolvedValue({
      register: vi.fn().mockResolvedValue(undefined),
      getHttpAdapter: vi.fn(() => ({ getInstance: () => ({ addHook: mockAddHook }) })),
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
        network: { ...DEFAULT_APP_CONFIG.proxy.network, lan_access: true },
      }),
    ).resolves.toMatchObject({ success: true, port: 8124 });

    expect(listen).toHaveBeenCalledWith({ port: 8124, host: '::', ipv6Only: false });
    expect(enableCors).toHaveBeenCalledOnce();
  });

  it('falls back to IPv4 only when the platform has no IPv6 listener support', async () => {
    const listen = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error('IPv6 is unavailable'), { code: 'EAFNOSUPPORT' }),
      )
      .mockResolvedValueOnce(undefined);
    mockCreate.mockResolvedValue({
      register: vi.fn().mockResolvedValue(undefined),
      getHttpAdapter: vi.fn(() => ({ getInstance: () => ({ addHook: mockAddHook }) })),
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
      port: 8125,
      api_key: 'test-api-key',
      network: { ...DEFAULT_APP_CONFIG.proxy.network, lan_access: true },
    });

    expect(result).toMatchObject({ success: true, port: 8125, listen_address: '0.0.0.0' });
    expect(listen).toHaveBeenNthCalledWith(1, { port: 8125, host: '::', ipv6Only: false });
    expect(listen).toHaveBeenNthCalledWith(2, 8125, '0.0.0.0');
  });

  it('does not hide a LAN port conflict behind an IPv4 fallback', async () => {
    const listen = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error('port is in use'), { code: 'EADDRINUSE' }));
    mockCreate.mockResolvedValue({
      register: vi.fn().mockResolvedValue(undefined),
      getHttpAdapter: vi.fn(() => ({ getInstance: () => ({ addHook: mockAddHook }) })),
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
      port: 8126,
      api_key: 'test-api-key',
      network: { ...DEFAULT_APP_CONFIG.proxy.network, lan_access: true },
    });

    expect(result).toEqual({
      success: false,
      reason: 'address-in-use',
      port: 8126,
      message: 'Port 8126 is already in use',
    });
    expect(listen).toHaveBeenCalledTimes(1);
  });
});
