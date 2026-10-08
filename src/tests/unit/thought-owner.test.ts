import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CoreRpcClient } from '@/core/rpc/client';
import { ManagementServer } from '@/core/management/server';
import { createCoreRpcOperations } from '@/core/rpc/router';
import {
  createThoughtOwner,
  thoughtOwner,
} from '@/modules/proxy-gateway/thought-store/thought-owner.service';
import type { ThoughtStoreService } from '@/modules/proxy-gateway/thought-store/thought-store.service';
import type { ThoughtRecord } from '@/modules/proxy-gateway/thought-store/thought-store.types';
import {
  selectThoughtAdapter,
  readSelectedThoughtRecord,
  getThoughtAdapter,
} from '@/modules/proxy-gateway/ipc/thought-adapter';
import {
  createAuditCurlOwner,
  auditCurlOwner,
} from '@/modules/proxy-gateway/traffic-monitor/audit-curl-owner.service';
import { selectAuditCurlAdapter } from '@/modules/proxy-gateway/ipc/audit-curl-adapter';
import { copyAuditCurl } from '@/modules/proxy-gateway/traffic-monitor/copy-audit-curl';
import { toPublicORPCError } from '@/ipc/router';

const clipboard = vi.hoisted(() => ({ writeText: vi.fn() }));
vi.mock('electron', () => ({ clipboard }));
const sessionKey = 'tenant:session';
const record: ThoughtRecord = {
  id: 1,
  createdAt: 10,
  fingerprint: 'fingerprint',
  model: 'gemini',
  sourceFamily: 'gemini',
  thought: '🙂正文',
  visible: 'visible',
  signature: 'signature',
  toolIds: ['tool-id'],
  toolNames: ['tool-name'],
  oversized: false,
  oversizedBytes: null,
  oversizedSha256: null,
};
const stats = {
  databaseBytes: 40,
  memorySessions: 1,
  sessions: 1,
  writeFailures: 0,
  workerAlive: true,
  workerPendingBytes: 0,
  workerPendingCommands: 0,
};
const sessions = [{ bytes: 10, endedAt: null, lastAccessed: 10, recordCount: 1, sessionKey }];
const summaries = [
  {
    createdAt: 10,
    id: 1,
    model: 'gemini',
    oversized: false,
    oversizedBytes: null,
    sourceFamily: 'gemini',
    thoughtBytes: 10,
  },
];
const source = {
  listSessions: vi.fn<ThoughtStoreService['listSessions']>(async () => sessions),
  listRecords: vi.fn<ThoughtStoreService['listRecords']>(async () => summaries),
  getRecord: vi.fn<ThoughtStoreService['getRecord']>(async () => record),
  stats: vi.fn(async () => stats),
  deleteSession: vi.fn(async () => 1),
  clear: vi.fn(async () => 1),
  repair: vi.fn(async () => ({ repaired: true, backupPath: 'owner/backup.db' })),
};
const audit = { recordAdminOperation: vi.fn() };
const build = vi.fn(async () => 'curl https://example.test');
let owner: ReturnType<typeof createThoughtOwner>;
let curlOwner: ReturnType<typeof createAuditCurlOwner>;
let server: ManagementServer | undefined;
let directory: string;
let release: (() => void) | undefined;

beforeEach(async () => {
  vi.clearAllMocks();
  directory = await mkdtemp(join(tmpdir(), 'agm-thought-owner-'));
  owner = createThoughtOwner(source, audit);
  curlOwner = createAuditCurlOwner(build);
  selectThoughtAdapter({ mode: 'desktop-embedded' });
  selectAuditCurlAdapter({ mode: 'desktop-embedded' });
});
afterEach(async () => {
  release?.();
  release = undefined;
  await server?.close();
  server = undefined;
  owner.closeAdmission();
  curlOwner.closeAdmission();
  await owner.drain();
  await curlOwner.drain();
  selectThoughtAdapter({ mode: 'desktop-embedded' });
  selectAuditCurlAdapter({ mode: 'desktop-embedded' });
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
      thought: owner,
      auditCurl: curlOwner,
    },
  });
  await server.start();
  const client = new CoreRpcClient(endpoint);
  selectThoughtAdapter({ mode: 'standalone-core', client });
  selectAuditCurlAdapter({ mode: 'standalone-core', client });
  return client;
}

describe('selected Thought Store and cURL owners', () => {
  it('routes summaries and maintenance through the private endpoint and records admin events in the owner', async () => {
    await remote();
    const embedded = vi.spyOn(thoughtOwner, 'stats');
    const selected = getThoughtAdapter();
    expect(
      await selected.sessions({ limit: 50, offset: 0, search: 'session', model: 'gemini' }),
    ).toEqual(sessions);
    expect(await selected.records({ sessionKey })).toEqual(summaries);
    expect(await selected.stats()).toEqual(stats);
    expect(await selected.delete({ sessionKey })).toEqual({ affected: 1 });
    expect(await selected.clear()).toEqual({ affected: 1 });
    expect(await selected.repair()).toEqual({ repaired: true, backupPath: 'owner/backup.db' });
    expect(audit.recordAdminOperation.mock.calls).toEqual([
      ['delete_thought_session', 1],
      ['clear_thought_sessions', 1],
      ['repair_thought_store'],
    ]);
    expect(source.listSessions).toHaveBeenCalledWith(50, 0, 'session', 'gemini');
    expect(embedded).not.toHaveBeenCalled();
  });

  it('transfers a record above the normal response cap with UTF-8, controls and all existing fields intact', async () => {
    const client = await remote();
    const large = {
      ...record,
      thought: '🙂正文\u0000'.repeat(150000),
      visible: 'visible\u0000'.repeat(30000),
      signature: 'signature🙂'.repeat(1000),
    };
    source.getRecord.mockResolvedValue(large);
    const opened = await client.thought.openRecord({ sessionKey, id: 1 });
    expect(opened).not.toHaveProperty('thought');
    expect(opened?.metadata).not.toHaveProperty('signature');
    if (opened) {
      await client.thought.closeContent({
        epoch: opened.transfer.epoch,
        capabilityId: opened.transfer.capabilityId,
        kind: 'thought',
        resourceId: opened.transfer.resourceId,
      });
    }
    expect(await readSelectedThoughtRecord({ sessionKey, id: 1 })).toEqual(large);
    source.getRecord.mockResolvedValue(record);
  });

  it('preserves the existing 64 MiB thought ceiling without JSON expansion or truncation', async () => {
    const large = {
      ...record,
      thought: 'x'.repeat(64 * 1024 * 1024),
      visible: '',
      signature: null,
    };
    source.getRecord.mockResolvedValue(large);
    selectThoughtAdapter({ mode: 'standalone-core', client: { thought: owner } });
    expect(await readSelectedThoughtRecord({ sessionKey, id: 1 })).toEqual(large);
    source.getRecord.mockResolvedValue(record);
  }, 30000);

  it('preserves missing records and null versus empty signatures', async () => {
    await remote();
    source.getRecord.mockResolvedValueOnce(null);
    expect(await readSelectedThoughtRecord({ sessionKey, id: 1 })).toBeNull();
    source.getRecord.mockResolvedValueOnce({ ...record, thought: '', visible: '', signature: '' });
    expect(await readSelectedThoughtRecord({ sessionKey, id: 1 })).toEqual({
      ...record,
      thought: '',
      visible: '',
      signature: '',
    });
  });

  it('does not expose cURL capabilities or commands to the renderer and allows shell expansion above 8 MiB', async () => {
    await remote();
    const embedded = vi.spyOn(auditCurlOwner, 'open');
    const command = 'curl ' + "'".repeat(9 * 1024 * 1024);
    build.mockResolvedValueOnce(command);
    expect(await copyAuditCurl({ id: randomUUID(), includeCredentials: true })).toBeUndefined();
    expect(clipboard.writeText.mock.calls).toEqual([[command]]);
    expect(embedded).not.toHaveBeenCalled();
  }, 30000);

  it('fails closed after disconnection or a worker error and never invokes an embedded owner', async () => {
    const client = await remote();
    const embedded = vi.spyOn(thoughtOwner, 'openRecord');
    source.getRecord.mockRejectedValueOnce(new Error('private database path and key'));
    await expect(readSelectedThoughtRecord({ sessionKey, id: 1 })).rejects.toThrow(
      'AI reasoning history is unavailable right now. Please try again.',
    );
    await expect(client.thought.records({ sessionKey: 'x'.repeat(513) })).rejects.toThrow(
      'AI reasoning history is unavailable right now. Please try again.',
    );
    await server?.close();
    server = undefined;
    await expect(readSelectedThoughtRecord({ sessionKey, id: 1 })).rejects.toThrow(
      'AI reasoning history is unavailable right now. Please try again.',
    );
    expect(embedded).not.toHaveBeenCalled();
    const projected = toPublicORPCError(
      new Error('private database path and key'),
      '["gateway","thoughtRecord"]',
    );
    expect(projected.message).toBe(
      'AI reasoning history is unavailable right now. Please try again.',
    );
    expect(projected.data).not.toHaveProperty('backendStack');
  });

  it('captures owner affinity across a selection change while opening a record', async () => {
    const client = await remote();
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    source.getRecord.mockImplementationOnce(async () => {
      await gate;
      return record;
    });
    const open = vi.spyOn(client.thought, 'openRecord');
    const read = readSelectedThoughtRecord({ sessionKey, id: 1 });
    selectThoughtAdapter({ mode: 'desktop-embedded' });
    release?.();
    expect(await read).toEqual(record);
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('drains admitted record reads and invalidates retained snapshots before persistence teardown', async () => {
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    source.getRecord.mockImplementationOnce(async () => {
      await gate;
      return record;
    });
    const opening = owner.openRecord({ sessionKey, id: 1 });
    owner.closeAdmission();
    await expect(owner.stats()).rejects.toThrow(
      'AI reasoning history is unavailable right now. Please try again.',
    );
    let drained = false;
    const drain = owner.drain().then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);
    release?.();
    expect(await opening).not.toBeNull();
    await drain;
    expect(drained).toBe(true);
  });
});
