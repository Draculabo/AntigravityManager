import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { createRouterClient, ORPCError } from '@orpc/server';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { CoreRpcClient } from '@/core/rpc/client';
import { ManagementServer } from '@/core/management/server';
import { createCoreRpcOperations } from '@/core/rpc/router';
import { OpenCodeSyncService } from '@/modules/proxy-gateway/opencode-sync/opencode-sync.service';
import { OpenCodeCredentialService } from '@/modules/proxy-gateway/opencode-sync/opencode-credential.service';
import {
  createOpenCodeOwner,
  openCodeOwner,
} from '@/modules/proxy-gateway/opencode-sync/opencode-owner.service';
import { selectOpenCodeAdapter } from '@/modules/proxy-gateway/ipc/opencode-adapter';
import { router, toPublicORPCError } from '@/ipc/router';
import { trafficAuditService } from '@/modules/proxy-gateway/audit/traffic-audit.service';
import { logger } from '@/shared/logging/logger';

const renderer = createRouterClient(router);

const baseUrl = 'http://127.0.0.1:8045';
const grant = 'fixture-private-refresh-grant';
const sourceAccounts = [
  { email: 'fixture@example.com', refreshToken: grant, projectId: 'project', lastUsed: 123 },
];
let directory = '';
let key = '';
let server: ManagementServer | undefined;
let owner: ReturnType<typeof createOpenCodeOwner>;
let release: (() => void) | undefined;
const loadAccounts = vi.fn(async () => sourceAccounts);
const detectInstallation = vi.fn(async () => ({ installed: true, version: '1.2.3' }));
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'agm-opencode-owner-'));
  key = 'agm_oc_fixture-private-key';
  release = undefined;
  loadAccounts.mockReset().mockResolvedValue(sourceAccounts);
  detectInstallation.mockReset().mockResolvedValue({ installed: true, version: '1.2.3' });
  const credentials = new OpenCodeCredentialService({
    read: () => key,
    write: (value) => {
      key = value;
    },
    delete: () => {
      key = '';
    },
  });
  owner = createOpenCodeOwner(
    new OpenCodeSyncService(directory, credentials, detectInstallation, loadAccounts),
    credentials,
  );
  for (const method of ['status', 'sync', 'preview', 'restore', 'clear', 'revokeKey'] as const) {
    vi.spyOn(openCodeOwner, method).mockImplementation(owner[method]);
  }
  vi.spyOn(logger, 'error').mockImplementation(() => {});
  selectOpenCodeAdapter({ mode: 'desktop-embedded' });
});
afterEach(async () => {
  release?.();
  await server?.close();
  server = undefined;
  await owner.drain();
  selectOpenCodeAdapter({ mode: 'desktop-embedded' });
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
      openCode: owner,
    },
  });
  await server.start();
  const client = new CoreRpcClient(endpoint);
  selectOpenCodeAdapter({ mode: 'standalone-core', client });
  return client;
}

describe('selected OpenCode owner', () => {
  it('keeps grants and the dedicated proxy key in owner-local effects with real remote parity', async () => {
    const embedded = await renderer.gateway.openCodeStatus({ baseUrl });
    const client = await remote();
    expect(await renderer.gateway.openCodeStatus({ baseUrl })).toEqual(embedded);
    const audit = vi.spyOn(trafficAuditService, 'startParent');
    const result = await renderer.gateway.syncOpenCode({ baseUrl, syncAccounts: true });
    expect(result.configPath).toBe(join(directory, '.config', 'opencode', 'opencode.json'));
    expect(loadAccounts).toHaveBeenCalledOnce();
    const accounts = JSON.parse(
      await readFile(join(directory, '.config', 'opencode', 'antigravity-accounts.json'), 'utf8'),
    );
    expect(accounts.accounts[0]).toMatchObject({
      email: 'fixture@example.com',
      refreshToken: grant,
      projectId: 'project',
    });
    const status = await client.openCode.status(baseUrl);
    const preview = await renderer.gateway.readOpenCodeConfig(undefined);
    expect(status.isSynced).toBe(true);
    expect(JSON.stringify({ result, status, preview })).not.toMatch(
      /fixture-private-refresh-grant|agm_oc_fixture-private-key/,
    );
    expect(audit).not.toHaveBeenCalled();
  });

  it('supports a bounded model table above the ordinary control-request cap', async () => {
    const client = await remote();
    const input = {
      baseUrl,
      models: Array.from({ length: 32 }, (_, index) => ({
        id: `fixture-model-${index}`,
        name: 'Model '.repeat(30).trim(),
      })),
    };
    expect(new TextEncoder().encode(JSON.stringify(input)).byteLength).toBeGreaterThan(4096);
    await client.openCode.sync(input);
    expect((await client.openCode.status(baseUrl)).models).toEqual(input.models);
  });

  it('retains external backup/restore and dedicated-key revocation behavior without revoking account grants', async () => {
    const configDirectory = join(directory, '.config', 'opencode');
    await mkdir(configDirectory, { recursive: true });
    await writeFile(join(configDirectory, 'opencode.json'), '{}\n');
    const client = await remote();
    await client.openCode.sync({ baseUrl, syncAccounts: true });
    expect((await client.openCode.status(baseUrl)).hasBackup).toBe(true);
    await client.openCode.restore();
    expect(JSON.parse(await readFile(join(configDirectory, 'opencode.json'), 'utf8'))).toEqual({
      provider: { 'antigravity-manager': { options: { apiKey: key } } },
    });
    await client.openCode.clear({ baseUrl, clearLegacy: true });
    expect(key).toBe('');
    expect(sourceAccounts).toEqual([
      { email: 'fixture@example.com', refreshToken: grant, projectId: 'project', lastUsed: 123 },
    ]);
    await client.openCode.revokeKey();
    expect(key).toBe('');
  });

  it('sanitizes failure and invalid-input diagnostics through the actual renderer middleware', async () => {
    await remote();
    loadAccounts.mockRejectedValue(new Error(`${grant} /private/account.json`));
    await expect(
      renderer.gateway.syncOpenCode({ baseUrl, syncAccounts: true }),
    ).rejects.toMatchObject({
      message: 'OpenCode settings are unavailable right now. Please try again.',
      data: { openCodeCode: 'operation-failed' },
    });
    await expect(
      renderer.gateway.syncOpenCode({ baseUrl: `http://user:${grant}@localhost` }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', data: { openCodeCode: 'invalid-input' } });
    expect(JSON.stringify(vi.mocked(logger.error).mock.calls)).not.toMatch(
      /fixture-private-refresh-grant|\/private\/account.json|backendStack|backendValue/,
    );
    expect(sourceAccounts[0].refreshToken).toBe(grant);
  });

  it('drains admitted synchronization and rejects new reads and writes while shutdown closes', async () => {
    const client = await remote();
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    loadAccounts.mockImplementation(async () => {
      await gate;
      return sourceAccounts;
    });
    const sync = client.openCode.sync({ baseUrl, syncAccounts: true });
    await vi.waitFor(() => expect(loadAccounts).toHaveBeenCalledOnce());
    owner.closeAdmission();
    const drained = vi.fn();
    const drain = owner.drain().then(drained);
    await expect(client.openCode.status(baseUrl)).rejects.toMatchObject({
      data: { openCodeCode: 'unavailable' },
    });
    await expect(client.openCode.revokeKey()).rejects.toMatchObject({
      data: { openCodeCode: 'unavailable' },
    });
    expect(drained).not.toHaveBeenCalled();
    release?.();
    await sync;
    await drain;
    expect(drained).toHaveBeenCalledOnce();
  });

  it('drains installation detection admitted by a status read before owner teardown', async () => {
    const client = await remote();
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    detectInstallation.mockImplementation(async () => {
      await gate;
      return { installed: true, version: '1.2.3' };
    });
    const status = client.openCode.status(baseUrl);
    await vi.waitFor(() => expect(detectInstallation).toHaveBeenCalledOnce());
    owner.closeAdmission();
    const drained = vi.fn();
    const drain = owner.drain().then(drained);
    expect(drained).not.toHaveBeenCalled();
    release?.();
    expect((await status).installed).toBe(true);
    await drain;
    expect(drained).toHaveBeenCalledOnce();
  });

  it('does not use embedded credential or file operations after remote disconnect', async () => {
    await remote();
    await server?.close();
    server = undefined;
    const embedded = vi.mocked(openCodeOwner.status);
    embedded.mockClear();
    await expect(renderer.gateway.openCodeStatus({ baseUrl })).rejects.toMatchObject({
      data: { openCodeCode: 'unavailable' },
    });
    expect(embedded).not.toHaveBeenCalled();
    expect(loadAccounts).not.toHaveBeenCalled();
  });

  it('retains closed configuration and legacy error categories without stacks at the public boundary', () => {
    const legacy = toPublicORPCError(
      new ORPCError('SERVICE_UNAVAILABLE', {
        message: grant,
        data: { accountCode: 'restore-failed' },
      }),
      '["account","switchAccount"]',
    );
    const configuration = toPublicORPCError(
      new ORPCError('BAD_REQUEST', { message: grant, data: { value: grant } }),
      '["config","service","writeSecret"]',
    );
    expect(legacy.data).toMatchObject({ accountCode: 'restore-failed' });
    expect(configuration.data).toMatchObject({ configCode: 'invalid-input' });
    expect(JSON.stringify([legacy, configuration])).not.toMatch(
      /fixture-private-refresh-grant|backendStack|backendValue/,
    );
  });
});
