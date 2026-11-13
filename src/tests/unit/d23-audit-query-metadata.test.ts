import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SqliteWorkerCommand } from '@/shared/persistence/sqlite-worker/bounded-sqlite-worker';
import { syntheticHarDetail } from '../support/audit-har-fixture';

const state = vi.hoisted(() => ({
  directory: '',
  writes: vi.fn<(command: SqliteWorkerCommand) => void>(),
  request: vi.fn<(command: SqliteWorkerCommand) => Promise<unknown>>(),
}));
vi.mock('@/shared/platform/paths', () => ({ getProxyStateDir: () => state.directory }));
vi.mock('@/shared/logging/logger', () => ({ logger: { warn: vi.fn(), info: vi.fn() } }));
vi.mock('@/server/server-config', async () => {
  const { DEFAULT_APP_CONFIG } = await import('@/modules/config/types');
  return {
    getServerConfig: () => ({
      ...DEFAULT_APP_CONFIG.proxy,
      traffic_audit: { ...DEFAULT_APP_CONFIG.proxy.traffic_audit, enabled: true },
    }),
  };
});
vi.mock('@/shared/persistence/sqlite-worker/bounded-sqlite-worker', () => ({
  BoundedSqliteWorker: class {
    start() {}
    getStats() {
      return { alive: true, pendingBytes: 0, pendingCommands: 0 };
    }
    request = state.request;
    async close() {}
    async drainAdmitted() {}
    tryWrite(command: SqliteWorkerCommand) {
      state.writes(command);
      return true;
    }
  },
}));

import { TrafficAuditService } from '@/modules/proxy-gateway/audit/traffic-audit.service';

let service: TrafficAuditService;
beforeEach(async () => {
  state.directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agm-query-metadata-'));
  state.writes.mockReset();
  state.request.mockReset();
  service = new TrafficAuditService();
});
afterEach(async () => {
  await service.shutdown();
  await fs.rm(state.directory, { recursive: true, force: true });
});

describe('audit query metadata boundary', () => {
  it.each([
    { key: ['first-secret', 'second-secret'], alt: 'sse' },
    'key=first-secret&k%65y=second-secret&alt=sse',
  ])('redacts URL and query before admitting a metadata write: %j', (query) => {
    const handle = service.startParent({
      method: 'GET',
      protocol: 'gemini',
      trafficClass: 'auxiliary',
      url: '/v1beta/models?key=first-secret&k%65y=second-secret&alt=sse',
      query,
      requestPayloadHandled: true,
    });
    expect(handle).not.toBeNull();
    const commands = state.writes.mock.calls.map(([command]) => command);
    expect(commands).toHaveLength(1);
    expect(commands[0].operation).toBe('insertParent');
    const serialized = JSON.stringify(commands[0]);
    expect(serialized).not.toMatch(/first-secret|second-secret/);
    expect(serialized).toContain('alt');
    expect(serialized).toContain('sse');
  });

  it('sanitizes historical metadata for list and detail without rewriting the stored row', async () => {
    const stored = syntheticHarDetail();
    stored.request.url = '/v1beta/models?key=historical-secret&alt=sse';
    stored.request.requestQuery = JSON.stringify({ key: 'historical-secret', alt: 'sse' });
    stored.attempts[0].endpoint = 'https://provider.test/models?k%65y=attempt-secret';
    stored.request.error = 'GET /v1beta/models?k%65y=historical-secret failed';
    stored.attempts[0].error = 'GET https://provider.test/models?key=attempt-secret failed';
    state.request.mockImplementation(async (command) => {
      if (command.operation === 'detail') {
        return structuredClone(stored);
      }
      return { items: [{ ...stored.request, recordKind: 'request' }], total: 1 };
    });
    const detail = await service.detail(stored.request.id);
    const list = await service.list({ limit: 50, offset: 0 });
    expect(JSON.stringify(detail)).not.toMatch(/historical-secret|attempt-secret/);
    expect(JSON.stringify(list)).not.toContain('historical-secret');
    expect(stored.request.url).toContain('historical-secret');
    expect(stored.request.requestQuery).toContain('historical-secret');
    expect(stored.attempts[0].endpoint).toContain('attempt-secret');
    expect(state.writes).not.toHaveBeenCalled();
  });
});
