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
