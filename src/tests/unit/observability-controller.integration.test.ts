import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_APP_CONFIG } from '@/modules/config/types';
import { getServerConfig, setServerConfig } from '@/server/server-config';
import {
  AuditManagementController,
  ThoughtManagementController,
} from '@/modules/proxy-gateway/server/modules/observability/observability.controller';
import { ThinkingController } from '@/modules/proxy-gateway/server/modules/thinking/thinking.controller';
import { AdminGuard } from '@/modules/proxy-gateway/server/guards/admin.guard';
import { ProxyGuard } from '@/modules/proxy-gateway/server/guards/proxy.guard';

const fixture = vi.hoisted(() => ({
  audit: {
    stats: vi.fn(async () => ({ totalRequests: 0 })),
    list: vi.fn(async () => ({ items: [], total: 0 })),
    filterOptions: vi.fn(async () => ({ accountIds: [], modelFamilies: [] })),
    detail: vi.fn(async () => null),
    bodyPage: vi.fn(async () => ({
      body: { kind: 'text', storedBytes: 1, state: 'complete', partial: false },
    })),
    bodyContent: vi.fn(() => ['a']),
    delete: vi.fn(async () => 2),
    clear: vi.fn(async () => 3),
    repair: vi.fn(async () => ({ repaired: true })),
    recordAdminOperation: vi.fn(),
  },
  thoughts: {
    stats: vi.fn(async () => ({ sessions: 0 })),
    listSessions: vi.fn(async () => []),
    getSession: vi.fn(async () => []),
    deleteSession: vi.fn(async () => 2),
    clear: vi.fn(async () => 3),
    repair: vi.fn(async () => ({ repaired: true })),
    endSession: vi.fn(async () => 1),
  },
}));
vi.mock('@/modules/proxy-gateway/audit/traffic-audit.service', () => ({
  trafficAuditService: fixture.audit,
}));
vi.mock('@/modules/proxy-gateway/thought-store/thought-store.service', () => ({
  thoughtStoreService: fixture.thoughts,
}));
vi.mock('@/modules/proxy-gateway/opencode-sync/opencode-credentials', () => ({
  openCodeCredentialService: { matches: () => false },
}));

@Module({
  controllers: [AuditManagementController, ThoughtManagementController, ThinkingController],
  providers: [AdminGuard, ProxyGuard],
})
class ControllerTestModule {}

const id = '00000000-0000-4000-8000-000000000001';
const cases = [
  {
    method: 'GET',
    url: '/internal/audit/stats',
    spy: fixture.audit.stats,
    body: { totalRequests: 0 },
  },
  {
    method: 'GET',
    url: '/internal/audit/requests',
    spy: fixture.audit.list,
    body: { items: [], total: 0 },
  },
  {
    method: 'GET',
    url: '/internal/audit/filter-options',
    spy: fixture.audit.filterOptions,
    body: { accountIds: [], modelFamilies: [] },
  },
  { method: 'GET', url: `/internal/audit/requests/${id}`, spy: fixture.audit.detail, body: null },
  {
    method: 'GET',
    url: `/internal/audit/bodies/${id}/chunks`,
    spy: fixture.audit.bodyPage,
    body: { body: { kind: 'text', storedBytes: 1, state: 'complete', partial: false } },
  },
  {
    method: 'GET',
    url: `/internal/audit/bodies/${id}/content`,
    spy: fixture.audit.bodyContent,
    body: 'a',
  },
  {
    method: 'DELETE',
    url: `/internal/audit/requests/${id}`,
    spy: fixture.audit.delete,
    body: { affected: 2 },
  },
  {
    method: 'DELETE',
    url: '/internal/audit/requests',
    spy: fixture.audit.clear,
    body: { affected: 3 },
  },
  {
    method: 'POST',
    url: '/internal/audit/repair',
    spy: fixture.audit.repair,
    body: { repaired: true },
  },
  {
    method: 'GET',
    url: '/internal/thinking/stats',
    spy: fixture.thoughts.stats,
    body: { sessions: 0 },
  },
  {
    method: 'GET',
    url: '/internal/thinking/sessions',
    spy: fixture.thoughts.listSessions,
    body: [],
  },
  {
    method: 'GET',
    url: '/internal/thinking/sessions/synthetic',
    spy: fixture.thoughts.getSession,
    body: [],
  },
  {
    method: 'DELETE',
    url: '/internal/thinking/sessions/synthetic',
    spy: fixture.thoughts.deleteSession,
    body: { affected: 2 },
  },
  {
    method: 'DELETE',
    url: '/internal/thinking/sessions',
    spy: fixture.thoughts.clear,
    body: { affected: 3 },
  },
  {
    method: 'POST',
    url: '/internal/thinking/repair',
    spy: fixture.thoughts.repair,
    body: { repaired: true },
  },
  {
    method: 'POST',
    url: '/v1/thinking/end',
    spy: fixture.thoughts.endSession,
    body: { ended: true, session_id: 'synthetic' },
  },
  {
    method: 'GET',
    url: '/v1/thinking/sessions/synthetic',
    spy: fixture.thoughts.getSession,
    body: { records: [], session_id: 'synthetic' },
  },
  {
    method: 'DELETE',
    url: '/v1/thinking/sessions/synthetic',
    spy: fixture.thoughts.deleteSession,
    body: { deleted: true, session_id: 'synthetic' },
  },
] as const;

let app: NestFastifyApplication;
const previous = getServerConfig() ?? DEFAULT_APP_CONFIG.proxy;
beforeAll(async () => {
  setServerConfig({ ...DEFAULT_APP_CONFIG.proxy, api_key: 'synthetic-key' });
  app = await NestFactory.create<NestFastifyApplication>(
    ControllerTestModule,
    new FastifyAdapter(),
    { logger: false },
  );
  await app.init();
});
beforeEach(() => {
  vi.clearAllMocks();
});
afterAll(async () => {
  await app?.close();
  setServerConfig(previous);
});

describe('observability HTTP contracts', () => {
  it.each(cases)(
    'rejects unauthenticated $method $url before accessing storage',
    async ({ method, url, spy }) => {
      const response = await app.inject({
        method,
        url,
        ...(method === 'POST' ? { payload: { session_id: 'synthetic' } } : {}),
      });
      expect(response.statusCode).toBe(401);
      expect(spy).not.toHaveBeenCalled();
    },
  );
  it.each(cases)(
    'delegates authenticated $method $url to its store',
    async ({ method, url, spy, body }) => {
      const response = await app.inject({
        method,
        url,
        headers: { authorization: 'Bearer synthetic-key' },
        ...(method === 'POST' ? { payload: { session_id: 'synthetic' } } : {}),
      });
      expect({
        status: response.statusCode,
        body:
          typeof body === 'string' ? response.body : response.body === '' ? null : response.json(),
      }).toEqual({ status: 200, body });
      expect(spy).toHaveBeenCalledOnce();
    },
  );
});

describe('management parameter validation', () => {
  const headers = { authorization: 'Bearer synthetic-key' };

  it('coerces audit filters, trims text and supplies pagination defaults', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/internal/audit/requests',
      headers,
      query: { from: '1', to: '20', status: '200', search: ' term ', ignored: 'unused' },
    });
    expect({ status: response.statusCode, body: response.json() }).toEqual({
      status: 200,
      body: { items: [], total: 0 },
    });
    expect(fixture.audit.list.mock.calls).toEqual([
      [{ from: 1, to: 20, status: 200, search: 'term', limit: 50, offset: 0 }],
    ]);
  });

  it('supplies and coerces thought pagination', async () => {
    await app.inject({ method: 'GET', url: '/internal/thinking/sessions', headers });
    await app.inject({
      method: 'GET',
      url: '/internal/thinking/sessions',
      headers,
      query: { limit: '8', offset: '2' },
    });
    expect(fixture.thoughts.listSessions.mock.calls).toEqual([
      [100, 0],
      [8, 2],
    ]);
  });

  it('validates the body id and coerces body pagination before querying the store', async () => {
    await app.inject({ method: 'GET', url: `/internal/audit/bodies/${id}/chunks`, headers });
    await app.inject({
      method: 'GET',
      url: `/internal/audit/bodies/${id}/chunks`,
      headers,
      query: { cursor: '3', limitBytes: '8' },
    });
    expect(fixture.audit.bodyPage.mock.calls).toEqual([
      [{ bodyId: id, cursor: 0, limitBytes: 256 * 1024 }],
      [{ bodyId: id, cursor: 3, limitBytes: 8 }],
    ]);
  });

  it.each(['GET', 'DELETE'] as const)('trims the %s thought session key', async (method) => {
    const response = await app.inject({
      method,
      url: `/internal/thinking/sessions/${encodeURIComponent(' synthetic ')}`,
      headers,
    });
    expect(response.statusCode).toBe(200);
    const spy = method === 'GET' ? fixture.thoughts.getSession : fixture.thoughts.deleteSession;
    expect(spy.mock.calls).toEqual([['synthetic']]);
  });

  it.each([
    { url: '/internal/audit/requests/not-a-uuid', spy: fixture.audit.detail },
    { url: '/internal/audit/bodies/not-a-uuid/chunks', spy: fixture.audit.bodyPage },
    { url: '/internal/audit/bodies/not-a-uuid/content', spy: fixture.audit.bodyPage },
  ])('preserves the complete UUID error at $url', async ({ url, spy }) => {
    const response = await app.inject({ method: 'GET', url, headers });
    expect({ status: response.statusCode, body: response.json() }).toEqual({
      status: 400,
      body: { formErrors: ['Invalid UUID'], fieldErrors: {} },
    });
    expect(spy).not.toHaveBeenCalled();
  });

  it('rejects an invalid request id before deletion', async () => {
    const response = await app.inject({
      method: 'DELETE',
      url: '/internal/audit/requests/not-a-uuid',
      headers,
    });
    expect({ status: response.statusCode, body: response.json() }).toEqual({
      status: 400,
      body: { formErrors: ['Invalid UUID'], fieldErrors: {} },
    });
    expect(fixture.audit.delete).not.toHaveBeenCalled();
  });

  it.each([
    { url: '/internal/audit/requests', spy: fixture.audit.list },
    { url: '/internal/thinking/sessions', spy: fixture.thoughts.listSessions },
  ])('preserves the complete query error at $url', async ({ url, spy }) => {
    const response = await app.inject({ method: 'GET', url, headers, query: { limit: '0' } });
    expect({ status: response.statusCode, body: response.json() }).toEqual({
      status: 400,
      body: {
        formErrors: [],
        fieldErrors: { limit: ['Too small: expected number to be >=1'] },
      },
    });
    expect(spy).not.toHaveBeenCalled();
  });

  it('preserves path-error precedence when both body id and query are invalid', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/internal/audit/bodies/not-a-uuid/chunks',
      headers,
      query: { limitBytes: '0' },
    });
    expect({ status: response.statusCode, body: response.json() }).toEqual({
      status: 400,
      body: { formErrors: ['Invalid UUID'], fieldErrors: {} },
    });
    expect(fixture.audit.bodyPage).not.toHaveBeenCalled();
  });

  it('rejects a blank session key without deleting or recording an operation', async () => {
    const response = await app.inject({
      method: 'DELETE',
      url: `/internal/thinking/sessions/${encodeURIComponent(' ')}`,
      headers,
    });
    expect({ status: response.statusCode, body: response.json() }).toEqual({
      status: 400,
      body: {
        formErrors: ['Too small: expected string to have >=1 characters'],
        fieldErrors: {},
      },
    });
    expect(fixture.thoughts.deleteSession).not.toHaveBeenCalled();
    expect(fixture.audit.recordAdminOperation).not.toHaveBeenCalled();
  });
});

describe('management operation audit decorators', () => {
  const headers = { authorization: 'Bearer synthetic-key' };
  const operations = [
    {
      method: 'DELETE' as const,
      url: '/internal/thinking/sessions/synthetic',
      spy: fixture.thoughts.deleteSession,
      audit: ['delete_thought_session', 2],
      body: { affected: 2 },
    },
    {
      method: 'DELETE' as const,
      url: '/internal/thinking/sessions',
      spy: fixture.thoughts.clear,
      audit: ['clear_thought_sessions', 3],
      body: { affected: 3 },
    },
    {
      method: 'POST' as const,
      url: '/internal/thinking/repair',
      spy: fixture.thoughts.repair,
      audit: ['repair_thought_store'],
      body: { repaired: true },
    },
  ];

  it.each(operations)(
    'records $method $url once after success',
    async ({ method, url, audit, body }) => {
      const response = await app.inject({ method, url, headers });
      expect({ status: response.statusCode, body: response.json() }).toEqual({ status: 200, body });
      expect(fixture.audit.recordAdminOperation.mock.calls).toEqual([audit]);
    },
  );

  it.each(operations)(
    'does not record failed $method $url mutations',
    async ({ method, url, spy }) => {
      spy.mockRejectedValueOnce(new Error('Mutation failed'));
      const response = await app.inject({ method, url, headers });
      expect({ status: response.statusCode, body: response.json() }).toEqual({
        status: 500,
        body: { statusCode: 500, message: 'Internal server error' },
      });
      expect(fixture.audit.recordAdminOperation).not.toHaveBeenCalled();
    },
  );

  it.each(operations)(
    'does not record rejected $method $url authentication',
    async ({ method, url }) => {
      const response = await app.inject({ method, url });
      expect(response.statusCode).toBe(401);
      expect(fixture.audit.recordAdminOperation).not.toHaveBeenCalled();
    },
  );

  it('waits for the mutation to complete and retains a zero affected count', async () => {
    let complete!: (value: number) => void;
    let started!: () => void;
    const mutation = new Promise<number>((resolve) => {
      complete = resolve;
    });
    const admitted = new Promise<void>((resolve) => {
      started = resolve;
    });
    fixture.thoughts.deleteSession.mockImplementationOnce(() => {
      started();
      return mutation;
    });
    const responsePromise = app
      .inject({ method: 'DELETE', url: '/internal/thinking/sessions/synthetic', headers })
      .then((response) => response);
    await admitted;
    try {
      expect(fixture.audit.recordAdminOperation).not.toHaveBeenCalled();
    } finally {
      complete(0);
    }
    const response = await responsePromise;
    expect({ status: response.statusCode, body: response.json() }).toEqual({
      status: 200,
      body: { affected: 0 },
    });
    expect(fixture.audit.recordAdminOperation.mock.calls).toEqual([['delete_thought_session', 0]]);
  });

  it('preserves recorder failures after a completed mutation', async () => {
    fixture.audit.recordAdminOperation.mockImplementationOnce(() => {
      throw new Error('Audit failed');
    });
    const response = await app.inject({
      method: 'DELETE',
      url: '/internal/thinking/sessions',
      headers,
    });
    expect({ status: response.statusCode, body: response.json() }).toEqual({
      status: 500,
      body: { statusCode: 500, message: 'Internal server error' },
    });
    expect(fixture.thoughts.clear).toHaveBeenCalledOnce();
    expect(fixture.audit.recordAdminOperation.mock.calls).toEqual([['clear_thought_sessions', 3]]);
  });
});
