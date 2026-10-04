import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CoreRpcClient } from '@/core/rpc/client';
import { ManagementServer } from '@/core/management/server';
import { createCoreRpcOperations } from '@/core/rpc/router';
import {
  auditFileOwner,
  createAuditFileOwner,
} from '@/modules/proxy-gateway/audit/audit-file-owner.service';
import { AuditFileExportInputSchema } from '@/modules/proxy-gateway/audit/audit-file-owner.schema';
import { MAX_AUDIT_BODY_BYTES } from '@/modules/proxy-gateway/audit/audit-sanitizer';
import { selectAuditFileAdapter } from '@/modules/proxy-gateway/ipc/audit-file-adapter';
import { exportSelectedAuditBody } from '@/modules/proxy-gateway/ipc/audit-file-desktop';

let directory: string;
let server: ManagementServer | undefined;
let owner: ReturnType<typeof createAuditFileOwner>;
let release: (() => void) | undefined;
const bodyId = randomUUID();
const content = vi.fn<(id: string) => AsyncGenerator<string>>();

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'agm-audit-file-'));
  release = undefined;
  content.mockReset().mockImplementation(async function* () {
    yield 'first\n';
    yield 'second\n';
  });
  owner = createAuditFileOwner({ bodyContent: content });
  selectAuditFileAdapter({ mode: 'desktop-embedded' });
});
afterEach(async () => {
  release?.();
  await server?.close();
  server = undefined;
  await owner.drain();
  selectAuditFileAdapter({ mode: 'desktop-embedded' });
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
      auditFile: owner,
    },
  });
  await server.start();
  const client = new CoreRpcClient(endpoint);
  selectAuditFileAdapter({ mode: 'standalone-core', client });
  return client;
}

describe('selected audit file owner', () => {
  it('writes an export above the RPC response cap in the remote owner and returns status only', async () => {
    await remote();
    const embedded = vi.spyOn(auditFileOwner, 'exportBody');
    const chunk = '正文🙂'.repeat(50000);
    content.mockImplementation(async function* () {
      yield chunk;
      yield chunk;
      yield chunk;
    });
    const path = join(directory, 'body.txt');
    const result = await exportSelectedAuditBody(bodyId, 'body.txt', async () => path);
    expect(Buffer.byteLength(chunk.repeat(3))).toBeGreaterThan(1024 * 1024);
    expect(result).toEqual({ status: 'saved' });
    expect(await readFile(path, 'utf8')).toBe(chunk.repeat(3));
    expect(content).toHaveBeenCalledExactlyOnceWith(bodyId);
    expect(embedded).not.toHaveBeenCalled();
    expect((await readdir(directory)).filter((name) => name !== 'core.sock')).toEqual(['body.txt']);
  });

  it('preserves the destination and removes temporary output when owner reading fails', async () => {
    const client = await remote();
    const path = join(directory, 'existing.txt');
    await writeFile(path, 'original');
    content.mockImplementation(async function* () {
      yield 'incomplete';
      throw new Error('fixture-private-grant /private/profile.db');
    });
    await expect(client.auditFile.exportBody({ bodyId, filePath: path })).rejects.toMatchObject({
      message: 'Audit export is unavailable.',
    });
    expect(await readFile(path, 'utf8')).toBe('original');
    expect((await readdir(directory)).filter((name) => name !== 'core.sock')).toEqual([
      'existing.txt',
    ]);
  });

  it('preserves an existing destination when streamed content exceeds the existing audit limit', async () => {
    const path = join(directory, 'limited.txt');
    await writeFile(path, 'original');
    const chunk = 'x'.repeat(1024 * 1024);
    content.mockImplementation(async function* () {
      for (let index = 0; index <= MAX_AUDIT_BODY_BYTES / chunk.length; index += 1) {
        yield chunk;
      }
    });
    await expect(owner.exportBody({ bodyId, filePath: path })).rejects.toThrow(
      'Audit export is unavailable.',
    );
    expect(await readFile(path, 'utf8')).toBe('original');
    expect((await readdir(directory)).filter((name) => name !== 'core.sock')).toEqual([
      'limited.txt',
    ]);
  });

  it('captures the owner before selection and cancellation performs no owner work', async () => {
    await remote();
    const embedded = vi.spyOn(auditFileOwner, 'exportBody');
    expect(await exportSelectedAuditBody(bodyId, 'name.txt', async () => null)).toEqual({
      status: 'cancelled',
    });
    expect(content).not.toHaveBeenCalled();
    const path = join(directory, 'selected.txt');
    expect(
      await exportSelectedAuditBody(bodyId, '../unsafe name.txt', async (name) => {
        expect(name).toBe('..-unsafe-name.txt');
        selectAuditFileAdapter({ mode: 'desktop-embedded' });
        return path;
      }),
    ).toEqual({ status: 'saved' });
    expect(await readFile(path, 'utf8')).toBe('first\nsecond\n');
    expect(embedded).not.toHaveBeenCalled();
  });

  it('drains admitted reading and writing while rejecting new exports', async () => {
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    content.mockImplementation(async function* () {
      yield 'before';
      await gate;
      yield 'after';
    });
    const client = await remote();
    const path = join(directory, 'drained.txt');
    const pending = client.auditFile.exportBody({ bodyId, filePath: path });
    await vi.waitFor(() => expect(content).toHaveBeenCalledOnce());
    owner.closeAdmission();
    const drained = vi.fn();
    const drain = owner.drain().then(drained);
    await expect(
      client.auditFile.exportBody({ bodyId, filePath: join(directory, 'late.txt') }),
    ).rejects.toMatchObject({ message: 'Audit export is unavailable.' });
    expect(drained).not.toHaveBeenCalled();
    release?.();
    await pending;
    await drain;
    expect(await readFile(path, 'utf8')).toBe('beforeafter');
    expect((await readdir(directory)).filter((name) => name !== 'core.sock')).toEqual([
      'drained.txt',
    ]);
  });

  it('fails without creating an embedded file reader after remote disconnection', async () => {
    await remote();
    await server?.close();
    server = undefined;
    const embedded = vi.spyOn(auditFileOwner, 'exportBody');
    await expect(
      exportSelectedAuditBody(bodyId, 'body.txt', async () => join(directory, 'body.txt')),
    ).rejects.toMatchObject({ message: 'Audit export is unavailable.' });
    expect(embedded).not.toHaveBeenCalled();
    expect(content).not.toHaveBeenCalled();
    expect((await readdir(directory)).filter((name) => name !== 'core.sock')).toEqual([]);
  });

  it('rejects malformed renderer IDs before selection and bounds private destination inputs', async () => {
    const selectPath = vi.fn(async () => join(directory, 'body.txt'));
    await expect(exportSelectedAuditBody('invalid', 'body.txt', selectPath)).rejects.toThrow(
      'Audit export is unavailable.',
    );
    expect(selectPath).not.toHaveBeenCalled();
    expect(AuditFileExportInputSchema.safeParse({ bodyId, filePath: 'relative.txt' }).success).toBe(
      false,
    );
    expect(
      AuditFileExportInputSchema.safeParse({ bodyId, filePath: join(directory, 'a'.repeat(3000)) })
        .success,
    ).toBe(false);
  });
});
