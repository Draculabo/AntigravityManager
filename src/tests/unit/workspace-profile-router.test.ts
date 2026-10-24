import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRouterClient } from '@orpc/server';

import { createWorkspaceRouter, toWorkspaceORPCError } from '@/modules/workspace/ipc/router';
import {
  createWorkspaceProfileService,
  type WorkspaceLifecycleDelegate,
} from '@/modules/workspace/services/workspace-profile.service';
import { WorkspaceProfileRepo } from '@/modules/workspace/persistence/workspace-profile-repo';
import {
  WorkspaceNotFoundError,
  AccountNotFoundError,
  ActiveWorkspaceDeletionError,
  WorkspaceValidationError,
  WorkspaceDirectoryError,
  type WorkspaceProfile,
} from '@/modules/workspace/types';
import type { CloudAccount } from '@/modules/cloud-account/types';

// Un-mock better-sqlite3 for genuine SQLite persistence
vi.mock('better-sqlite3', async () => {
  const { createRequire } = await import('node:module');
  return { default: createRequire(import.meta.url)('better-sqlite3') };
});

const dialogMocks = vi.hoisted(() => ({
  showOpenDialog: vi.fn(),
}));

vi.mock('electron', () => ({
  dialog: {
    showOpenDialog: dialogMocks.showOpenDialog,
  },
}));

describe('Workspace Profile Router IPC (R1) - Genuine Integration', () => {
  let tempDir: string;
  let testDbPath: string;
  let client: any;
  let lifecycleDelegate: WorkspaceLifecycleDelegate;
  let isRunning: boolean;

  const seedAccount: CloudAccount = {
    id: 'account-seed-1',
    provider: 'google',
    email: 'engineer@example.com',
    name: 'Staff Engineer',
    token: {
      access_token: 'fake-token',
      refresh_token: 'fake-refresh',
      expires_in: 3600,
      expiry_timestamp: Date.now() + 3600000,
      token_type: 'Bearer',
    },
    created_at: 1700000000,
    last_used: 1700000000,
    status: 'active',
    is_active: true,
  };

  const cloudAccountRepoMock = {
    getAccounts: vi.fn(async () => [seedAccount]),
    getAccount: vi.fn(async (id: string) => (id === seedAccount.id ? seedAccount : null)),
  };

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agm-router-test-'));
    testDbPath = path.join(tempDir, 'cloud_accounts.db');
    WorkspaceProfileRepo.setDatabasePath(testDbPath);

    // Bootstrap test SQLite database schema
    const db = new Database(testDbPath);
    db.pragma('journal_mode = WAL');
    db.exec(`
      CREATE TABLE IF NOT EXISTS accounts (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        email TEXT NOT NULL,
        name TEXT,
        token_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_used INTEGER NOT NULL,
        status TEXT DEFAULT 'active',
        is_active INTEGER DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS workspace_profiles (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        account_id TEXT NOT NULL,
        project_path TEXT NOT NULL,
        user_data_dir TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_launched_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_workspace_profiles_account_id ON workspace_profiles(account_id);
      CREATE INDEX IF NOT EXISTS idx_workspace_profiles_created_at ON workspace_profiles(created_at);
    `);
    db.close();

    isRunning = false;
    lifecycleDelegate = {
      getStatus: vi.fn(async (_profile: WorkspaceProfile) => ({
        running: isRunning,
        pid: isRunning ? 54321 : undefined,
      })),
      launch: vi.fn(async (_id: string) => {
        isRunning = true;
        return { pid: 54321 };
      }),
      stop: vi.fn(async (_id: string) => {
        isRunning = false;
      }),
    };

    const service = createWorkspaceProfileService({
      profileRepo: WorkspaceProfileRepo,
      cloudAccountRepo: cloudAccountRepoMock,
      lifecycleDelegate,
    });

    const router = createWorkspaceRouter(service);
    client = createRouterClient(router);
  });

  afterEach(() => {
    WorkspaceProfileRepo.setDatabasePath(null);
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup error
    }
    vi.restoreAllMocks();
  });

  // =========================================================================
  // 1. Router Procedure: create
  // =========================================================================
  describe('workspaceRouter.create', () => {
    it('creates a workspace profile with genuine schema validation and database insertion', async () => {
      const projectDir = path.join(tempDir, 'sample-project');
      fs.mkdirSync(projectDir, { recursive: true });

      const created = await client.create({
        name: 'Backend Workspace',
        accountId: seedAccount.id,
        projectPath: projectDir,
      });

      expect(created).toBeDefined();
      expect(created.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(created.name).toBe('Backend Workspace');
      expect(created.accountId).toBe(seedAccount.id);
      expect(created.projectPath).toBe(projectDir);
      expect(created.lastLaunchedAt).toBeNull();
      expect(fs.existsSync(created.userDataDir)).toBe(true);
    });

    it('rejects creation with empty name with BAD_REQUEST', async () => {
      await expect(
        client.create({
          name: '',
          accountId: seedAccount.id,
          projectPath: '/tmp/any',
        }),
      ).rejects.toMatchObject({
        code: 'BAD_REQUEST',
      });
    });

    it('rejects creation with non-existent account ID with BAD_REQUEST', async () => {
      await expect(
        client.create({
          name: 'Orphan Workspace',
          accountId: 'phantom-account-id',
          projectPath: '/tmp/any',
        }),
      ).rejects.toMatchObject({
        code: 'BAD_REQUEST',
      });
    });

    it('rejects creation with relative projectPath with BAD_REQUEST', async () => {
      await expect(
        client.create({
          name: 'Relative Workspace',
          accountId: seedAccount.id,
          projectPath: './relative/path',
        }),
      ).rejects.toMatchObject({
        code: 'BAD_REQUEST',
      });
    });
  });

  // =========================================================================
  // 2. Router Procedure: list
  // =========================================================================
  describe('workspaceRouter.list', () => {
    it('returns array of enriched WorkspaceProfileView items', async () => {
      const projectDir = path.join(tempDir, 'list-project');
      fs.mkdirSync(projectDir, { recursive: true });

      const created = await client.create({
        name: 'List Target',
        accountId: seedAccount.id,
        projectPath: projectDir,
      });

      const list = await client.list();
      expect(list).toHaveLength(1);
      expect(list[0].id).toBe(created.id);
      expect(list[0].name).toBe('List Target');
      expect(list[0].status).toEqual({ running: false });
      expect(list[0].account?.email).toBe(seedAccount.email);
    });

    it('returns empty array when no profiles exist', async () => {
      const list = await client.list();
      expect(list).toEqual([]);
    });
  });

  // =========================================================================
  // 3. Router Procedure: get
  // =========================================================================
  describe('workspaceRouter.get', () => {
    it('returns enriched WorkspaceProfileView for existing ID', async () => {
      const projectDir = path.join(tempDir, 'get-project');
      fs.mkdirSync(projectDir, { recursive: true });

      const created = await client.create({
        name: 'Get Target',
        accountId: seedAccount.id,
        projectPath: projectDir,
      });

      const fetched = await client.get({ id: created.id });
      expect(fetched).not.toBeNull();
      expect(fetched!.id).toBe(created.id);
      expect(fetched!.name).toBe('Get Target');
      expect(fetched!.account?.email).toBe(seedAccount.email);
    });

    it('returns null cleanly when profile does not exist', async () => {
      const nonExistentUuid = '99999999-9999-4999-a999-999999999999';
      const fetched = await client.get({ id: nonExistentUuid });
      expect(fetched).toBeNull();
    });

    it('rejects invalid non-UUID ID with BAD_REQUEST schema error', async () => {
      await expect(client.get({ id: 'invalid-not-uuid' })).rejects.toMatchObject({
        code: 'BAD_REQUEST',
      });
    });
  });

  // =========================================================================
  // 4. Router Procedure: update
  // =========================================================================
  describe('workspaceRouter.update', () => {
    it('updates profile mutable fields and persists to SQLite', async () => {
      const projectDir = path.join(tempDir, 'update-project');
      fs.mkdirSync(projectDir, { recursive: true });

      const created = await client.create({
        name: 'Original Name',
        accountId: seedAccount.id,
        projectPath: projectDir,
      });

      const updated = await client.update({
        id: created.id,
        name: 'Updated Name',
      });

      expect(updated.name).toBe('Updated Name');

      const fetched = await client.get({ id: created.id });
      expect(fetched!.name).toBe('Updated Name');
    });

    it('throws NOT_FOUND when updating non-existent profile ID', async () => {
      const nonExistentUuid = '99999999-9999-4999-a999-999999999991';
      await expect(
        client.update({
          id: nonExistentUuid,
          name: 'Ghost Update',
        }),
      ).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
    });
  });

  // =========================================================================
  // 5. Router Procedure: launch & stop
  // =========================================================================
  describe('workspaceRouter.launch and stop', () => {
    it('launches workspace via lifecycle delegate and passes output schema validation', async () => {
      const projectDir = path.join(tempDir, 'launch-project');
      fs.mkdirSync(projectDir, { recursive: true });

      const created = await client.create({
        name: 'Launch Target',
        accountId: seedAccount.id,
        projectPath: projectDir,
      });

      const result = await client.launch({ id: created.id });
      expect(result).toBeDefined();
      expect(result.pid).toBe(54321);
      expect(lifecycleDelegate.launch).toHaveBeenCalledWith(created.id);

      // Verify lastLaunchedAt timestamp was updated in SQLite
      const fetched = await client.get({ id: created.id });
      expect(fetched!.lastLaunchedAt).toBeGreaterThan(0);
    });

    it('launches cleanly on default service without delegate returning { pid: 0 }', async () => {
      // Create service without lifecycleDelegate (Milestone M1 state)
      const serviceNoDelegate = createWorkspaceProfileService({
        profileRepo: WorkspaceProfileRepo,
        cloudAccountRepo: cloudAccountRepoMock,
      });
      const routerNoDelegate = createWorkspaceRouter(serviceNoDelegate);
      const clientNoDelegate = createRouterClient(routerNoDelegate);

      const projectDir = path.join(tempDir, 'm1-default-launch');
      fs.mkdirSync(projectDir, { recursive: true });

      const created = await clientNoDelegate.create({
        name: 'M1 Launch Target',
        accountId: seedAccount.id,
        projectPath: projectDir,
      });

      // Crucial: Must NOT throw Zod output schema error on pid: 0!
      const result = await clientNoDelegate.launch({ id: created.id });
      expect(result).toEqual({ pid: 0 });
    });

    it('throws NOT_FOUND when launching non-existent profile ID', async () => {
      const nonExistentUuid = '99999999-9999-4999-a999-999999999992';
      await expect(client.launch({ id: nonExistentUuid })).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
    });

    it('stops workspace via lifecycle delegate', async () => {
      const projectDir = path.join(tempDir, 'stop-project');
      fs.mkdirSync(projectDir, { recursive: true });

      const created = await client.create({
        name: 'Stop Target',
        accountId: seedAccount.id,
        projectPath: projectDir,
      });

      await client.stop({ id: created.id });
      expect(lifecycleDelegate.stop).toHaveBeenCalledWith(created.id);
    });

    it('throws NOT_FOUND when stopping non-existent profile ID', async () => {
      const nonExistentUuid = '99999999-9999-4999-a999-999999999993';
      await expect(client.stop({ id: nonExistentUuid })).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
    });
  });

  // =========================================================================
  // 6. Router Procedure: delete
  // =========================================================================
  describe('workspaceRouter.delete', () => {
    it('deletes stopped profile and purges userDataDir on disk', async () => {
      const projectDir = path.join(tempDir, 'delete-project');
      fs.mkdirSync(projectDir, { recursive: true });

      const created = await client.create({
        name: 'Delete Target',
        accountId: seedAccount.id,
        projectPath: projectDir,
      });

      expect(fs.existsSync(created.userDataDir)).toBe(true);

      await client.delete({ id: created.id, cleanUserDataDir: true });

      expect(await client.get({ id: created.id })).toBeNull();
      expect(fs.existsSync(created.userDataDir)).toBe(false);
    });

    it('preserves userDataDir when cleanUserDataDir is false', async () => {
      const projectDir = path.join(tempDir, 'preserve-project');
      fs.mkdirSync(projectDir, { recursive: true });

      const created = await client.create({
        name: 'Preserve Target',
        accountId: seedAccount.id,
        projectPath: projectDir,
      });

      await client.delete({ id: created.id, cleanUserDataDir: false });

      expect(await client.get({ id: created.id })).toBeNull();
      expect(fs.existsSync(created.userDataDir)).toBe(true);
    });

    it('enforces ActiveWorkspaceDeletionError when attempting to delete running workspace without force', async () => {
      const projectDir = path.join(tempDir, 'active-project');
      fs.mkdirSync(projectDir, { recursive: true });

      const created = await client.create({
        name: 'Active Target',
        accountId: seedAccount.id,
        projectPath: projectDir,
      });

      // Mark workspace as running
      isRunning = true;

      await expect(client.delete({ id: created.id })).rejects.toMatchObject({
        code: 'BAD_REQUEST',
        message: expect.stringContaining('Cannot delete a running workspace'),
      });

      // Verify record still exists in SQLite
      expect(await client.get({ id: created.id })).not.toBeNull();
    });

    it('allows deleting running workspace when force is true', async () => {
      const projectDir = path.join(tempDir, 'force-active-project');
      fs.mkdirSync(projectDir, { recursive: true });

      const created = await client.create({
        name: 'Force Delete Target',
        accountId: seedAccount.id,
        projectPath: projectDir,
      });

      isRunning = true;

      await client.delete({ id: created.id, force: true });

      expect(lifecycleDelegate.stop).toHaveBeenCalledWith(created.id);
      expect(await client.get({ id: created.id })).toBeNull();
    });

    it('throws NOT_FOUND when deleting non-existent profile ID', async () => {
      const nonExistentUuid = '99999999-9999-4999-a999-999999999994';
      await expect(client.delete({ id: nonExistentUuid })).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
    });
  });

  // =========================================================================
  // 7. Router Procedure: selectDirectory
  // =========================================================================
  describe('workspaceRouter.selectDirectory', () => {
    it('returns selected folder path when user picks a folder', async () => {
      dialogMocks.showOpenDialog.mockResolvedValueOnce({
        canceled: false,
        filePaths: ['/selected/project/folder'],
      });

      const selected = await client.selectDirectory({ defaultPath: '/default/path' });
      expect(selected).toBe('/selected/project/folder');
      expect(dialogMocks.showOpenDialog).toHaveBeenCalledWith({
        title: 'Select Workspace Project Folder',
        defaultPath: '/default/path',
        properties: ['openDirectory', 'createDirectory'],
      });
    });

    it('returns null when dialog is canceled by user', async () => {
      dialogMocks.showOpenDialog.mockResolvedValueOnce({
        canceled: true,
        filePaths: [],
      });

      const selected = await client.selectDirectory();
      expect(selected).toBeNull();
    });

    it('translates dialog errors to INTERNAL_SERVER_ERROR', async () => {
      dialogMocks.showOpenDialog.mockRejectedValueOnce(new Error('Native dialog failed'));

      await expect(client.selectDirectory()).rejects.toMatchObject({
        code: 'INTERNAL_SERVER_ERROR',
      });
    });
  });

  // =========================================================================
  // 8. Error Mapping: toWorkspaceORPCError
  // =========================================================================
  describe('toWorkspaceORPCError Translation Matrix', () => {
    it('maps domain errors to corresponding oRPC status codes', () => {
      const errNotFound = toWorkspaceORPCError(new WorkspaceNotFoundError('ws-1'));
      expect(errNotFound.code).toBe('NOT_FOUND');

      const errAccNotFound = toWorkspaceORPCError(new AccountNotFoundError('acc-1'));
      expect(errAccNotFound.code).toBe('BAD_REQUEST');

      const errActiveDel = toWorkspaceORPCError(new ActiveWorkspaceDeletionError('ws-1'));
      expect(errActiveDel.code).toBe('BAD_REQUEST');

      const errValidation = toWorkspaceORPCError(new WorkspaceValidationError('bad data'));
      expect(errValidation.code).toBe('BAD_REQUEST');

      const errDir = toWorkspaceORPCError(new WorkspaceDirectoryError('/bad/dir'));
      expect(errDir.code).toBe('INTERNAL_SERVER_ERROR');

      const errGeneral = toWorkspaceORPCError(new Error('unknown crash'));
      expect(errGeneral.code).toBe('INTERNAL_SERVER_ERROR');
    });
  });
});
