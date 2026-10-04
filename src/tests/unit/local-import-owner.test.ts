import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRouterClient } from '@orpc/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ManagementServer } from '@/core/management/server';
import { CoreRpcClient } from '@/core/rpc/client';
import { createCoreRpcOperations } from '@/core/rpc/router';
import { selectCloudAccountAdapter } from '@/modules/cloud-account/ipc/cloud-account-adapter';
import { localAccountImportRouter } from '@/modules/cloud-account/local-import/ipc/router';
import {
  localAccountImportCoordinator,
  LocalAccountImportCoordinatorService,
} from '@/modules/cloud-account/local-import/local-account-import-coordinator.service';
import { LocalAccountDiscoverySession } from '@/modules/cloud-account/local-import/local-account-discovery.service';
import { LocalAccountValidationSession } from '@/modules/cloud-account/local-import/local-account-validation.service';
import { LocalAccountImportService } from '@/modules/cloud-account/local-import/local-account-import.service';
import { localAccountPostImportService } from '@/modules/cloud-account/local-import/local-account-post-import.service';
import { CloudAccountRepo } from '@/modules/cloud-account/persistence/cloudHandler';
import {
  cloudAccountListService,
  createCloudAccountListService,
} from '@/modules/cloud-account/services/cloud-account-list.service';
import { LocalAccountImportPreviewSchema } from '@/modules/cloud-account/local-import/transport.schema';
import type { CloudAccount } from '@/modules/cloud-account/types';

vi.mock('@/modules/cloud-account/persistence/cloudHandler', () => ({
  CloudAccountRepo: { getAccounts: vi.fn() },
}));
vi.mock('@/modules/cloud-account/local-import/local-account-post-import.service', () => ({
  localAccountPostImportService: { schedule: vi.fn(), drain: vi.fn(), getStatus: vi.fn() },
}));
const credential = {
  refreshToken: 'fixture-refresh-secret',
  accessToken: 'fixture-access-secret',
  idToken: 'fixture-id-secret',
};
const summary = {
  fingerprint: 'fingerprint-a',
  sources: [{ id: 'antigravity-keyring' as const, location: 'system-keyring' }],
  emailHints: ['person@example.com'],
  hasAccessToken: true,
  hasIdToken: true,
  identity: { email: 'person@example.com' },
};
const discovery = new LocalAccountDiscoverySession(
  {
    accounts: [summary],
    failures: [],
    sourceSummaries: [],
    duplicateCount: 0,
    emailCollisionGroups: [],
  },
  new Map([[summary.fingerprint, credential]]),
);
const validation = new LocalAccountValidationSession(
  { accounts: [summary], failed: [], merged: [], discoveryFailures: [] },
  new Map([[summary.fingerprint, credential]]),
);
let accounts: CloudAccount[];
let service: LocalAccountImportCoordinatorService;
let server: ManagementServer | null;
let directory: string;
let now: number;
let persistGate: Promise<void> | undefined;
let saved: ReturnType<typeof vi.fn<() => void>>;
const renderer = createRouterClient(localAccountImportRouter);
const postTask = {
  taskId: '00000000-0000-4000-8000-000000000101',
  status: 'completed' as const,
  totalAccounts: 1,
  completedAccounts: 1,
  refreshedAccountIds: ['imported-account'],
  failedAccountIds: [],
  cacheReloadStatus: 'reloaded' as const,
  createdAt: 1,
};

beforeEach(async () => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.mocked(localAccountPostImportService.schedule).mockReturnValue(postTask.taskId);
  vi.mocked(localAccountPostImportService.getStatus).mockReturnValue(postTask);
  accounts = [];
  now = Date.now();
  persistGate = undefined;
  saved = vi.fn();
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agm-local-owner-'));
  vi.mocked(CloudAccountRepo.getAccounts).mockImplementation(async () => accounts);
  const listing = createCloudAccountListService({
    getAccounts: () => CloudAccountRepo.getAccounts(),
    backfillOAuthClientKeys: async () => false,
    refreshProcessCache: async () => {},
    getCurrentAccountInfo: () => ({ isAuthenticated: false, email: '' }),
    usesCredentialStore: () => false,
    getActiveAccountId: () => '',
    warn: vi.fn(),
  });
  vi.spyOn(cloudAccountListService, 'listViews').mockImplementation(listing.listViews);
  const importer = new LocalAccountImportService({
    getAccounts: async () => accounts,
    upsertAccounts: async (values) => {
      saved();
      await persistGate;
      accounts = values;
    },
    createId: () => 'imported-account',
    now: () => Math.floor(now / 1000),
  });
  service = new LocalAccountImportCoordinatorService({
    dependencies: {
      discover: async () => discovery,
      validate: async () => validation,
      importSession: (session) => importer.importSession(session),
      schedulePostImport: (ids) => localAccountPostImportService.schedule(ids),
      getPostImportStatus: (id) => localAccountPostImportService.getStatus(id),
      createSessionId: randomUUID,
      now: () => now,
    },
  });
  for (const method of [
    'preview',
    'confirm',
    'discard',
    'getPostImportStatus',
    'closeAdmission',
    'drain',
  ] as const) {
    vi.spyOn(localAccountImportCoordinator, method).mockImplementation(
      service[method].bind(service),
    );
  }
  selectCloudAccountAdapter({ mode: 'desktop-embedded' });
});
afterEach(async () => {
  selectCloudAccountAdapter({ mode: 'desktop-embedded' });
  await server?.close();
  server = null;
  vi.restoreAllMocks();
  await fs.rm(directory, { recursive: true, force: true });
});
async function remote() {
  const endpoint =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\agm-local-${path.basename(directory)}`
      : path.join(directory, 'core.sock');
  const operations = createCoreRpcOperations({ startGateway: vi.fn(), stopGateway: vi.fn() });
  server = new ManagementServer({
    endpoint,
    getStatus: () => ({ state: 'running', pid: 123, gateway: { running: false, port: null } }),
    shutdown: async () => {},
    onShutdownError: vi.fn(),
    rpc: operations,
  });
  await server.start();
  const client = new CoreRpcClient(endpoint);
  selectCloudAccountAdapter({ mode: 'standalone-core', client });
  return { client, operations };
}

describe('selected local-import owner', () => {
  it('preserves preview parity and persists a one-shot remote confirmation inside its owner', async () => {
    const embedded = await renderer.preview();
    const { client } = await remote();
    const preview = await renderer.preview();
    expect({ ...preview, sessionId: embedded.sessionId }).toEqual(embedded);
    const results = await Promise.allSettled([
      renderer.confirm({ sessionId: preview.sessionId }),
      renderer.confirm({ sessionId: preview.sessionId }),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(saved).toHaveBeenCalledOnce();
    expect(accounts[0].token.refresh_token).toBe(credential.refreshToken);
    expect(localAccountPostImportService.schedule).toHaveBeenCalledExactlyOnceWith([
      'imported-account',
    ]);
    expect(await renderer.getPostImportStatus({ taskId: postTask.taskId })).toEqual(postTask);
    const views = await client.accountViews();
    expect(views[0]).toMatchObject({ id: 'imported-account', email: summary.identity.email });
    const serialized = JSON.stringify({ preview, results, views });
    for (const secret of Object.values(credential)) {
      expect(serialized).not.toContain(secret);
    }
  });
  it('preserves discard and expiry categories over the private endpoint', async () => {
    await remote();
    const discarded = await renderer.preview();
    expect(await renderer.discard({ sessionId: discarded.sessionId })).toEqual({ discarded: true });
    await expect(renderer.confirm({ sessionId: discarded.sessionId })).rejects.toMatchObject({
      data: { localAccountImportErrorCode: 'session-consumed' },
    });
    const expired = await renderer.preview();
    now = expired.expiresAt;
    await expect(renderer.confirm({ sessionId: expired.sessionId })).rejects.toMatchObject({
      data: { localAccountImportErrorCode: 'session-expired' },
    });
    expect(saved).not.toHaveBeenCalled();
  });
  it('rejects a session after adapter reselection, even when returning to embedded mode', async () => {
    const old = await renderer.preview();
    await remote();
    await expect(renderer.confirm({ sessionId: old.sessionId })).rejects.toMatchObject({
      data: { localAccountImportErrorCode: 'session-not-found' },
    });
    selectCloudAccountAdapter({ mode: 'desktop-embedded' });
    await expect(renderer.confirm({ sessionId: old.sessionId })).rejects.toMatchObject({
      data: { localAccountImportErrorCode: 'session-not-found' },
    });
    expect(saved).not.toHaveBeenCalled();
  });
  it('invalidates secret sessions at owner close and never falls back after remote failure', async () => {
    const { client, operations } = await remote();
    const preview = await renderer.preview();
    operations.closeAccountMutationAdmission();
    service.openAdmission();
    await expect(client.localImportConfirm(preview.sessionId)).rejects.toMatchObject({
      data: { localAccountImportErrorCode: 'internal-error' },
    });
    await expect(service.confirm(preview.sessionId)).rejects.toMatchObject({
      code: 'session-not-found',
    });
    await server!.close();
    server = null;
    const previewCalls = vi.mocked(localAccountImportCoordinator.preview).mock.calls.length;
    await expect(renderer.preview()).rejects.toMatchObject({
      data: { localAccountImportErrorCode: 'internal-error' },
    });
    expect(localAccountImportCoordinator.preview).toHaveBeenCalledTimes(previewCalls);
    const restarted = await remote();
    await expect(restarted.client.localImportConfirm(preview.sessionId)).rejects.toMatchObject({
      data: { localAccountImportErrorCode: 'session-not-found' },
    });
  });
  it('drains admitted persistence and post-import work and rejects new confirmations', async () => {
    let release!: () => void;
    let releasePostImport!: () => void;
    vi.mocked(localAccountPostImportService.drain).mockReturnValueOnce(
      new Promise<void>((resolve) => {
        releasePostImport = resolve;
      }),
    );
    persistGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { client, operations } = await remote();
    const preview = await client.localImportPreview();
    const confirmation = client.localImportConfirm(preview.sessionId);
    await vi.waitFor(() => expect(saved).toHaveBeenCalledOnce());
    operations.closeAccountMutationAdmission();
    let drained = false;
    const draining = operations.drainAccountMutations().then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);
    await expect(client.localImportConfirm(preview.sessionId)).rejects.toMatchObject({
      data: { localAccountImportErrorCode: 'internal-error' },
    });
    release();
    await confirmation;
    await vi.waitFor(() => expect(localAccountPostImportService.drain).toHaveBeenCalledOnce());
    expect(drained).toBe(false);
    releasePostImport();
    await draining;
    expect(accounts).toHaveLength(1);
    expect(localAccountPostImportService.drain).toHaveBeenCalledOnce();
  });
  it('rejects oversized and credential-bearing preview transport', async () => {
    const preview = await service.preview();
    expect(
      LocalAccountImportPreviewSchema.safeParse({
        ...preview,
        accounts: Array.from({ length: 257 }, () => summary),
      }).success,
    ).toBe(false);
    expect(
      LocalAccountImportPreviewSchema.safeParse({
        ...preview,
        accounts: [{ ...summary, refreshToken: credential.refreshToken }],
      }).success,
    ).toBe(false);
    expect(
      LocalAccountImportPreviewSchema.safeParse({
        ...preview,
        accounts: [
          { ...summary, sources: [{ id: 'antigravity-keyring', location: 'x'.repeat(1025) }] },
        ],
      }).success,
    ).toBe(false);
  });
});
