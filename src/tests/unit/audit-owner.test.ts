import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CoreRpcClient } from '@/core/rpc/client';
import { ManagementServer } from '@/core/management/server';
import { createCoreRpcOperations } from '@/core/rpc/router';
import { auditOwner, createAuditOwner } from '@/modules/proxy-gateway/audit/audit-owner.service';
import { AuditOwnerEvents } from '@/modules/proxy-gateway/audit/audit-owner-events';
import { selectAuditAdapter, getAuditAdapter } from '@/modules/proxy-gateway/ipc/audit-adapter';
import { subscribeSelectedAuditEvents } from '@/modules/proxy-gateway/ipc/audit-presentation';
import { toPublicORPCError } from '@/ipc/router';
import type { TrafficAuditEvent } from '@/modules/proxy-gateway/audit/traffic-audit.types';
import type { TrafficAuditService } from '@/modules/proxy-gateway/audit/traffic-audit.service';

const id = randomUUID();
const stats = {
  bodyStoredBytes: 123,
  databaseBytes: 456,
  droppedCount: 0,
  incompleteBodies: 0,
  lastDropReason: null,
  oldestTimestamp: null,
  rows: 7,
  workerAlive: true,
  workerPendingBytes: 0,
  workerPendingCommands: 0,
};
let publish: (event: TrafficAuditEvent) => void;
let owner: ReturnType<typeof createAuditOwner>;
let server: ManagementServer | undefined;
let directory: string;
let release: (() => void) | undefined;
let stopPresentation: (() => void) | undefined;
const source = {
  list: vi.fn(async () => ({ items: [], total: 0 })),
  filterOptions: vi.fn(async () => ({ accountIds: ['account-one'], modelFamilies: ['gemini'] })),
  detail: vi.fn(async () => null),
  bodyPage: vi.fn<TrafficAuditService['bodyPage']>(async () => null),
  bodySearch: vi.fn(async () => ({ matches: [], truncated: false })),
  stats: vi.fn(async () => stats),
  delete: vi.fn(async () => 1),
  clear: vi.fn(async () => 7),
  repair: vi.fn(async () => ({ repaired: true, backupPath: 'owner/backup.db' })),
  subscribe: vi.fn((listener: (event: TrafficAuditEvent) => void) => {
    publish = listener;
    return vi.fn();
  }),
};

beforeEach(async () => {
  vi.clearAllMocks();
  directory = await mkdtemp(join(tmpdir(), 'agm-audit-owner-'));
  owner = createAuditOwner(source);
  selectAuditAdapter({ mode: 'desktop-embedded' });
});
afterEach(async () => {
  stopPresentation?.();
  stopPresentation = undefined;
  release?.();
  release = undefined;
  vi.useRealTimers();
  await server?.close();
  server = undefined;
  owner.closeAdmission();
  await owner.drain();
  selectAuditAdapter({ mode: 'desktop-embedded' });
  vi.restoreAllMocks();
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

async function remote() {
  const endpoint =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\${basename(directory)}`
      : join(directory, 'core.sock');
  server = new ManagementServer({
    endpoint,
    getStatus: () => ({
      state: 'running',
      pid: process.pid,
      gateway: { running: false, port: null },
    }),
    shutdown: async () => {},
    onShutdownError: vi.fn(),
    rpc: {
      ...createCoreRpcOperations({ startGateway: vi.fn(), stopGateway: vi.fn() }),
      audit: owner,
    },
  });
  await server.start();
  const client = new CoreRpcClient(endpoint);
  selectAuditAdapter({ mode: 'standalone-core', client });
  return client;
}

describe('selected audit owner', () => {
  it('preserves persisted administrative IDs for detail and deletion', async () => {
    const client = await remote();
    expect(await client.audit.detail({ id: 'admin:42' })).toBeNull();
    expect(await client.audit.delete({ id: 'admin:42' })).toEqual({ affected: 1 });
    expect(source.detail).toHaveBeenCalledWith('admin:42');
    expect(source.delete).toHaveBeenCalledWith('admin:42');
  });

  it('pages JSON-expanded content without dropping chunks or raising response limits', async () => {
    const client = await remote();
    const chunks = Array.from({ length: 4 }, (_, sequence) => ({
      sequence,
      data: '\u0000'.repeat(64 * 1024),
    }));
    const body = {
      chunkCount: 4,
      completedAt: 1,
      direction: 'request' as const,
      droppedReason: null,
      errorSummary: null,
      id,
      kind: 'text' as const,
      logicalBytes: 256 * 1024,
      oversized: false,
      ownerId: id,
      ownerKind: 'parent' as const,
      parseErrorOffset: null,
      partial: false,
      representation: 'sanitized_text' as const,
      sha256: null,
      sha256Scope: 'unavailable' as const,
      state: 'complete' as const,
      storedBytes: 256 * 1024,
      terminalStatus: 'completed',
    };
    source.bodyPage.mockImplementation(async (input) => ({
      body,
      chunks: chunks.slice(input.cursor),
      complete: true,
      nextCursor: null,
    }));
    const first = await client.audit.bodyPage({ bodyId: id, cursor: 0, limitBytes: 256 * 1024 });
    expect(first).toEqual({ body, chunks: chunks.slice(0, 2), complete: false, nextCursor: 2 });
    const second = await client.audit.bodyPage({ bodyId: id, cursor: 2, limitBytes: 256 * 1024 });
    expect(second).toEqual({ body, chunks: chunks.slice(2), complete: true, nextCursor: null });
    expect([...(first?.chunks ?? []), ...(second?.chunks ?? [])]).toEqual(chunks);
    source.bodyPage.mockImplementation(async () => null);
  });

  it('routes ordinary reads, paging/search and mutations through the real private transport', async () => {
    await remote();
    const embedded = vi.spyOn(auditOwner, 'stats');
    const selected = getAuditAdapter();
    expect(await selected.list({ limit: 50, offset: 0 })).toEqual({ items: [], total: 0 });
    expect(await selected.filterOptions()).toEqual({
      accountIds: ['account-one'],
      modelFamilies: ['gemini'],
    });
    expect(await selected.detail({ id })).toBeNull();
    expect(await selected.bodyPage({ bodyId: id, cursor: 0, limitBytes: 256 * 1024 })).toBeNull();
    expect(await selected.bodySearch({ bodyId: id, query: 'needle', limit: 100 })).toEqual({
      matches: [],
      truncated: false,
    });
    expect(await selected.stats()).toEqual(stats);
    expect(await selected.delete({ id })).toEqual({ affected: 1 });
    expect(await selected.clear({ trafficClass: null })).toEqual({ affected: 7 });
    expect(await selected.repair()).toEqual({ repaired: true, backupPath: 'owner/backup.db' });
    expect(source.delete).toHaveBeenCalledWith(id);
    expect(source.clear).toHaveBeenCalledWith(null);
    expect(embedded).not.toHaveBeenCalled();
  });

  it('keeps source failures and malformed inputs value-free at both public boundaries', async () => {
    const client = await remote();
    source.stats.mockRejectedValueOnce(new Error('private credential and path'));
    await expect(client.audit.stats()).rejects.toThrow('Request history is unavailable right now. Please try again.');
    await expect(client.audit.detail({ id: 'private-value' })).rejects.toThrow(
      'Request history is unavailable right now. Please try again.',
    );
    expect(source.detail).not.toHaveBeenCalled();
    const projected = toPublicORPCError(
      new Error('private credential and path'),
      '["gateway","auditStats"]',
    );
    expect(projected.message).toBe('Request history is unavailable right now. Please try again.');
    expect(projected.data).toEqual({
      auditCode: 'operation-failed',
      backendCode: 'SERVICE_UNAVAILABLE',
      backendStatus: 503,
      backendName: 'ORPCError',
      backendMessage: 'Request history is unavailable right now. Please try again.',
      requestPath: '["gateway","auditStats"]',
    });
  });

  it('rejects encoded oversized replies before transport without raising the normal cap', async () => {
    const client = await remote();
    source.filterOptions.mockResolvedValueOnce({
      accountIds: ['界'.repeat(310000)],
      modelFamilies: [],
    });
    await expect(client.audit.filterOptions()).rejects.toThrow('Request history is unavailable right now. Please try again.');
  });

  it('never falls back to an embedded worker after remote disconnect', async () => {
    await remote();
    const embedded = vi.spyOn(auditOwner, 'stats');
    await server?.close();
    server = undefined;
    await expect(getAuditAdapter().stats()).rejects.toThrow('Request history is unavailable right now. Please try again.');
    expect(embedded).not.toHaveBeenCalled();
  });

  it('drains admitted reads and serializes a mutation behind them after closing admission', async () => {
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    source.stats.mockImplementationOnce(async () => {
      await gate;
      return stats;
    });
    const read = owner.stats();
    const deletion = owner.delete({ id });
    owner.closeAdmission();
    await expect(owner.stats()).rejects.toThrow('Request history is unavailable right now. Please try again.');
    let drained = false;
    const drain = owner.drain().then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);
    expect(source.delete).not.toHaveBeenCalled();
    release?.();
    expect(await read).toEqual(stats);
    expect(await deletion).toEqual({ affected: 1 });
    await drain;
    expect(drained).toBe(true);
  });

  it('bounds queued owner work and retains already admitted calls', async () => {
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    source.stats.mockImplementationOnce(async () => {
      await gate;
      return stats;
    });
    const admitted = Array.from({ length: 128 }, () => owner.stats());
    await expect(owner.stats()).rejects.toThrow('Request history is unavailable right now. Please try again.');
    release?.();
    expect(await Promise.all(admitted)).toEqual(Array.from({ length: 128 }, () => stats));
  });

  it('delivers only bounded reference events over the private transport', async () => {
    const client = await remote();
    publish({ id, kind: 'updated', timestamp: 123, trafficClass: 'ipc' });
    const batch = await client.audit.events({ after: 0 });
    expect(batch).toEqual({
      epoch: expect.any(String),
      latest: 1,
      reset: true,
      events: [
        { sequence: 1, event: { id, kind: 'updated', timestamp: 123, trafficClass: 'ipc' } },
      ],
    });
    expect(await client.audit.events({ epoch: batch.epoch, after: 1 })).toEqual({
      epoch: batch.epoch,
      latest: 1,
      reset: false,
      events: [],
    });
  });
});

describe('audit presentation journal', () => {
  it('backs off after an unavailable owner and resumes without a local fallback', async () => {
    vi.useFakeTimers();
    const read = vi
      .spyOn(owner, 'events')
      .mockRejectedValueOnce(new Error('private worker detail'));
    const present = vi.fn();
    stopPresentation = subscribeSelectedAuditEvents(present, () => owner);
    await vi.advanceTimersByTimeAsync(1999);
    expect(read).toHaveBeenCalledTimes(1);
    expect(present).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(read).toHaveBeenCalledTimes(2);
    expect(present.mock.calls.map(([event]) => ({ ...event, timestamp: 0 }))).toEqual([
      { id: 'all', kind: 'cleared', timestamp: 0 },
    ]);
  });

  it('refreshes the renderer after overflow and delivers reference events in sequence', async () => {
    vi.useFakeTimers();
    const present = vi.fn();
    stopPresentation = subscribeSelectedAuditEvents(present, () => owner);
    await vi.advanceTimersByTimeAsync(0);
    present.mockClear();
    for (let index = 1; index <= 130; index++) {
      publish({ id, kind: 'updated', timestamp: index });
    }
    await vi.advanceTimersByTimeAsync(1250);
    expect(
      present.mock.calls.map(([event]) => ({
        ...event,
        timestamp: event.kind === 'cleared' ? 0 : event.timestamp,
      })),
    ).toEqual([
      { id: 'all', kind: 'cleared', timestamp: 0 },
      ...Array.from({ length: 128 }, (_, index) => ({ id, kind: 'updated', timestamp: index + 3 })),
    ]);
    stopPresentation();
    await vi.advanceTimersByTimeAsync(1000);
    expect(present).toHaveBeenCalledTimes(129);
  });

  it('signals overflow, bounds retained/batch events and resets a different epoch', () => {
    const journal = new AuditOwnerEvents();
    const initial = journal.read({ after: 0 });
    for (let index = 1; index <= 130; index++) {
      journal.publish({ id, kind: 'updated', timestamp: index });
    }
    const batch = journal.read({ epoch: initial.epoch, after: 0 });
    expect(batch).toEqual({
      epoch: initial.epoch,
      latest: 130,
      reset: true,
      events: Array.from({ length: 32 }, (_, index) => ({
        sequence: index + 3,
        event: { id, kind: 'updated', timestamp: index + 3 },
      })),
    });
    expect(journal.read({ epoch: initial.epoch, after: 129 })).toEqual({
      epoch: initial.epoch,
      latest: 130,
      reset: false,
      events: [{ sequence: 130, event: { id, kind: 'updated', timestamp: 130 } }],
    });
    expect(journal.read({ epoch: randomUUID(), after: 130 })).toEqual(batch);
  });

  it('discards a stale owner reply and stops subsequent polling', async () => {
    vi.useFakeTimers();
    const first = createAuditOwner(source);
    let selected = first;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const read = vi.spyOn(first, 'events').mockImplementationOnce(async (input) => {
      await gate;
      return owner.events(input);
    });
    const present = vi.fn();
    stopPresentation = subscribeSelectedAuditEvents(present, () => selected);
    selected = owner;
    release?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(read).toHaveBeenCalledTimes(1);
    expect(present).not.toHaveBeenCalled();
    stopPresentation();
    await vi.advanceTimersByTimeAsync(1000);
    expect(read).toHaveBeenCalledTimes(1);
    first.closeAdmission();
    await first.drain();
  });

  it('suppresses a pending reply and subsequent polling after window closure', async () => {
    vi.useFakeTimers();
    const original = owner.events;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const read = vi.spyOn(owner, 'events').mockImplementationOnce(async (input) => {
      await gate;
      return original(input);
    });
    const present = vi.fn();
    stopPresentation = subscribeSelectedAuditEvents(present, () => owner);
    stopPresentation();
    release?.();
    await vi.advanceTimersByTimeAsync(1000);
    expect(present).not.toHaveBeenCalled();
    expect(read).toHaveBeenCalledTimes(1);
  });
});
