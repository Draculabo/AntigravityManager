import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { TrafficAuditService } from '@/modules/proxy-gateway/audit/traffic-audit.service';
import { logger } from '@/shared/logging/logger';
import type { UsageRangeResult } from '@/modules/proxy-gateway/audit/usage-range.schema';

const state = vi.hoisted(() => ({
  directory: '',
  request: vi.fn<(command: unknown) => Promise<unknown>>(),
  close: vi.fn(async () => {}),
  readIdentity: vi.fn(),
}));
vi.mock('@/modules/cloud-account/incarnation', () => ({
  readCurrentCloudAccountUsageIdentity: state.readIdentity,
}));
vi.mock('@/shared/platform/paths', () => ({ getProxyStateDir: () => state.directory }));
vi.mock('@/server/server-config', () => ({ getServerConfig: () => undefined }));
vi.mock('@/shared/persistence/sqlite-worker/bounded-sqlite-worker', () => ({
  BoundedSqliteWorker: class {
    start() {}
    getStats() {
      return { alive: true, pendingBytes: 0, pendingCommands: 0 };
    }
    request = state.request;
    close = state.close;
  },
}));
vi.mock('@/modules/proxy-gateway/diagnostics/maintenance-scheduler', () => ({
  DiagnosticMaintenanceScheduler: class {
    start() {}
    stop() {}
  },
}));

const input = { accountId: 'synthetic-account', modelIds: ['claude-sonnet'], from: 1000, to: 2000 };
const identity = {
  accountGenerationHash: 'a'.repeat(64),
  accountSubjectHash: null,
  accountGrantHash: 'b'.repeat(64),
};
const result: UsageRangeResult = {
  ...input,
  asOf: 1800,
  coverage: 'retained-local-records',
  accountIdentity: 'current-account-incarnation',
  timeBasis: 'attempt-start',
  ambiguousTimeBasis: 'attempt-start-or-unattributed-request-start',
  recordedRequests: 0,
  countedRequests: 0,
  ambiguousRequests: 0,
  missingUsageRequests: 0,
  missingCachedRequests: 0,
  inputTokens: 0,
  outputTokens: 0,
  cachedTokens: 0,
  totalTokens: 0,
};
let service: TrafficAuditService;
beforeEach(() => {
  state.directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agm-cycle-usage-service-'));
  state.request.mockReset().mockResolvedValue(result);
  state.readIdentity.mockReset().mockResolvedValue(identity);
  state.close.mockClear();
  vi.spyOn(Date, 'now').mockReturnValue(1800);
  vi.spyOn(logger, 'warn').mockImplementation(() => {});
  service = new TrafficAuditService();
});
afterEach(async () => {
  await service.shutdown();
  vi.restoreAllMocks();
  fs.rmSync(state.directory, { recursive: true, force: true });
});
it('captures the owner clock once and sends only the strict bounded worker command', async () => {
  expect(await service.usageRange(input)).toEqual(result);
  expect(state.request.mock.calls).toEqual([
    [{ operation: 'usageRange', payload: { range: input, ...identity, asOf: 1800 } }],
  ]);
});
it('rejects invalid ranges before starting a worker query', async () => {
  await expect(service.usageRange({ ...input, modelIds: [] })).rejects.toThrow();
  expect(state.request).not.toHaveBeenCalled();
});
it('retains the original failure and stack in trusted diagnostics without retrying or returning zero', async () => {
  const error = new Error('Synthetic usage worker failure');
  state.request.mockRejectedValueOnce(error);
  await expect(service.usageRange(input)).rejects.toBe(error);
  expect(logger.warn).toHaveBeenCalledWith('Retained usage query failed', error);
  expect(state.request).toHaveBeenCalledTimes(1);
});
it('rejects malformed worker results and admission after shutdown', async () => {
  state.request.mockResolvedValueOnce({ ...result, totalTokens: 1 });
  await expect(service.usageRange(input)).rejects.toThrow();
  await service.shutdown();
  await expect(service.usageRange(input)).rejects.toThrow();
  expect(state.request).toHaveBeenCalledTimes(1);
  expect(state.close).toHaveBeenCalledTimes(1);
});
