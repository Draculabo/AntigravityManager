import type { WorkspaceProfile } from '@/modules/workspace/types';
import type { UpdateWorkspaceProfileInput } from '@/modules/workspace/types';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRouterClient, ORPCError, type RouterClient } from '@orpc/server';
import { dialog } from 'electron';

import { WorkspaceProfileRepo } from '@/modules/workspace/persistence/workspace-profile-repo';
import {
  WorkspaceNotFoundError,
  AccountNotFoundError,
  ActiveWorkspaceDeletionError,
  WorkspaceValidationError,
  WorkspaceDirectoryError,
  type WorkspaceLifecycleDelegate,
} from '@/modules/workspace/types';
import type { CloudAccount } from '@/modules/cloud-account/types';
import { createWorkspaceProfileService as createTestWorkspaceProfileService } from '@/modules/workspace/services/workspace-profile.service';
import {
  createWorkspaceRouter as createTestWorkspaceRouter,
  toWorkspaceORPCError,
} from '@/modules/workspace/ipc/router';

// Un-mock better-sqlite3 for genuine SQLite persistence
vi.mock('better-sqlite3', async () => {
  const { createRequire } = await import('node:module');
  return { default: createRequire(import.meta.url)('better-sqlite3') };
});

const mocks = vi.hoisted(() => ({
  showOpenDialog: vi.fn(),
  testDirectory: '',
}));

vi.mock('electron', () => ({
  dialog: {
    showOpenDialog: mocks.showOpenDialog,
  },
}));

vi.mock('@/shared/logging/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

vi.mock('@/shared/platform/paths', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/shared/platform/paths')>();
  return {
    ...actual,
    getCloudAccountsDbPath: () => path.join(mocks.testDirectory, 'cloud_accounts.db'),
    getProfilesBaseDir: () => path.join(mocks.testDirectory, 'profiles'),
    getProfileUserDataDir: (profileId: string) =>
      path.join(mocks.testDirectory, 'profiles', profileId),
  };
});

describe('Adversarial Empirical Stress Testing: Challenger M1-2', () => {
  let db: Database.Database;
  let dbPath: string;
  let profilesDir: string;
  let service: ReturnType<typeof createTestWorkspaceProfileService>;
  let client: RouterClient<ReturnType<typeof createTestWorkspaceRouter>>;
  let lifecycleDelegate: WorkspaceLifecycleDelegate;

  const validAccount: CloudAccount = {
    id: 'account-google-valid',
    provider: 'google',
    email: 'user@example.com',
    created_at: 1700000000,
    last_used: 1700000000,
    token: {
      access_token: 'fixture-access',
      refresh_token: 'fixture-refresh',
      expires_in: 3600,
      expiry_timestamp: 1900000000,
      token_type: 'Bearer',
    },
  };

  const cloudAccountRepo = {
    async getAccount(id: string) {
      return id === validAccount.id ? validAccount : null;
    },
    async getAccounts() {
      return [validAccount];
    },
  };

  let originalHome: string | undefined;

  beforeEach(() => {
    originalHome = process.env.HOME;
    mocks.testDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'agm-challenger-m1-2-'));
    process.env.HOME = mocks.testDirectory;

    dbPath = path.join(mocks.testDirectory, '.antigravity-agent', 'cloud_accounts.db');
    profilesDir = path.join(mocks.testDirectory, 'profiles');
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    fs.mkdirSync(profilesDir, { recursive: true });
    WorkspaceProfileRepo.setDatabasePath(dbPath);

    db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 3000');

    db.exec(`
      CREATE TABLE IF NOT EXISTS accounts (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        email TEXT NOT NULL,
        token_json TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL,
        last_used INTEGER NOT NULL,
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

    db.prepare(
      `
      INSERT INTO accounts (id, provider, email, created_at, last_used, token_json)
      VALUES (?, ?, ?, ?, ?, '{}')
    `,
    ).run(
      validAccount.id,
      validAccount.provider,
      validAccount.email,
      validAccount.created_at,
      validAccount.last_used,
    );

    lifecycleDelegate = {
      getStatuses: async (profiles: WorkspaceProfile[]) => profiles.map(() => ({ running: false })),
      applyUpdate: async (
        _id: string,
        _input: UpdateWorkspaceProfileInput,
        persist: () => Promise<WorkspaceProfile>,
      ) => persist(),
      getStatus: async () => ({ running: false }),
      launch: async () => ({ pid: 9999 }),
      stop: async () => {},
      withStoppedProfile: async (_id, _options, action) => action(),
    };
    service = createTestWorkspaceProfileService({
      profileRepo: WorkspaceProfileRepo,
      cloudAccountRepo,
      lifecycleDelegate,
    });
    const router = createTestWorkspaceRouter(service);
    client = createRouterClient(router);

    mocks.showOpenDialog.mockReset();
    vi.spyOn(dialog, 'showOpenDialog').mockImplementation((...args) =>
      mocks.showOpenDialog(...args),
    );
  });

  afterEach(() => {
    WorkspaceProfileRepo.setDatabasePath(null);
    try {
      db.close();
    } catch {
      // ignore database already closed
    }
    if (originalHome !== undefined) {
      process.env.HOME = originalHome;
    }
    vi.restoreAllMocks();
    fs.rmSync(mocks.testDirectory, { recursive: true, force: true });
  });

  // =========================================================================
  // Challenge 1: Architectural Coupling — REMEDIATED
  // Original challenge confirmed the router test was hollow. M1 remedy
  // rewrote it to be genuine. These tests now verify the remediated state.
  // =========================================================================
  describe('Challenge 1: Architectural Coupling & Portability Breakdown (Remediated)', () => {
    it('REMEDIATED: workspace-profile-router.test.ts now imports genuine router and service modules', async () => {
      const testContent = fs.readFileSync(
        path.resolve(process.cwd(), 'src/tests/unit/workspace-profile-router.test.ts'),
        'utf8',
      );
      // After M1 remedy, the router test is genuine and imports the real router
      expect(testContent.includes("from '@/modules/workspace/ipc/router'")).toBe(true);
      // It should no longer rely on hollow mock closures
      expect(testContent.includes('mocks.serviceList()')).toBe(false);
    });

    it('REMEDIATED: workspaceRouter can be imported without Node 26 parameter property errors', async () => {
      // After fixing parameter properties in credentialReadbackError.ts and
      // antigravityCredentialStore.ts, the router should import cleanly
      let routerError: any = null;
      try {
        await import('@/modules/workspace/ipc/router');
      } catch (err) {
        routerError = err;
      }
      // The import should succeed (no parameter property errors)
      expect(routerError).toBeNull();
    });
  });

  // =========================================================================
  // Challenge 2: Edge Conditions on IDs and Missing Resources
  // =========================================================================
  describe('Challenge 2: Non-Existent IDs & Missing Resources Handling', () => {
    const nonExistentUuid = '00000000-0000-4000-8000-000000000000';

    it('returns null cleanly when calling get with a valid UUID not in database', async () => {
      const res = await client.get({ id: nonExistentUuid });
      expect(res).toBeNull();
    });

    it('rejects get with invalid non-UUID string with BAD_REQUEST', async () => {
      await expect(client.get({ id: 'invalid-id' })).rejects.toMatchObject({
        code: 'BAD_REQUEST',
      });
    });

    it('throws NOT_FOUND when calling delete with a valid UUID not in database', async () => {
      await expect(client.delete({ id: nonExistentUuid })).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
    });

    it('rejects delete with invalid non-UUID string with BAD_REQUEST', async () => {
      await expect(client.delete({ id: '123' })).rejects.toMatchObject({
        code: 'BAD_REQUEST',
      });
    });

    it('throws NOT_FOUND when updating a valid UUID not in database', async () => {
      await expect(client.update({ id: nonExistentUuid, name: 'Renamed' })).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
    });

    it('throws NOT_FOUND when launching a valid UUID not in database', async () => {
      await expect(client.launch({ id: nonExistentUuid })).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
    });

    it('throws NOT_FOUND when stopping a valid UUID not in database', async () => {
      await expect(client.stop({ id: nonExistentUuid })).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
    });

    it('throws BAD_REQUEST when creating profile with non-existent account ID', async () => {
      await expect(
        client.create({
          name: 'Workspace',
          accountId: 'phantom-account-id',
          projectPath: '/workspaces/test',
        }),
      ).rejects.toMatchObject({
        code: 'BAD_REQUEST',
        message: expect.stringContaining('does not exist in the account pool'),
      });
    });

    it('throws BAD_REQUEST when updating profile to a non-existent account ID', async () => {
      const created = await client.create({
        name: 'Workspace',
        accountId: validAccount.id,
        projectPath: '/workspaces/test',
      });

      await expect(
        client.update({
          id: created.id,
          accountId: 'phantom-account-id',
        }),
      ).rejects.toMatchObject({
        code: 'BAD_REQUEST',
        message: expect.stringContaining('does not exist'),
      });
    });

    it('throws BAD_REQUEST when creating profile with a relative project path', async () => {
      await expect(
        client.create({
          name: 'Workspace',
          accountId: validAccount.id,
          projectPath: 'relative/path',
        }),
      ).rejects.toMatchObject({
        code: 'BAD_REQUEST',
        message: expect.stringContaining('must be an absolute path'),
      });
    });

    it('throws BAD_REQUEST when updating profile to a relative project path', async () => {
      const created = await client.create({
        name: 'Workspace',
        accountId: validAccount.id,
        projectPath: '/workspaces/test',
      });

      await expect(
        client.update({
          id: created.id,
          projectPath: './local/rel',
        }),
      ).rejects.toMatchObject({
        code: 'BAD_REQUEST',
        message: expect.stringContaining('must be an absolute path'),
      });
    });
  });

  // =========================================================================
  // Challenge 3: Native Folder Picker Edge Conditions
  // =========================================================================
  describe('Challenge 3: Native Folder Picker Edge Conditions', () => {
    it('returns null cleanly when user cancels the native folder picker', async () => {
      mocks.showOpenDialog.mockResolvedValueOnce({
        canceled: true,
        filePaths: [],
      });

      const selected = await client.selectDirectory();
      expect(selected).toBeNull();
      expect(mocks.showOpenDialog).toHaveBeenCalledWith(
        expect.objectContaining({
          properties: ['openDirectory', 'createDirectory'],
        }),
      );
    });

    it('returns null when dialog returns empty filePaths even if canceled is false', async () => {
      mocks.showOpenDialog.mockResolvedValueOnce({
        canceled: false,
        filePaths: [],
      });

      const selected = await client.selectDirectory();
      expect(selected).toBeNull();
    });

    it('returns selected directory path on user selection', async () => {
      mocks.showOpenDialog.mockResolvedValueOnce({
        canceled: false,
        filePaths: ['/home/user/code/my-project'],
      });

      const selected = await client.selectDirectory({ defaultPath: '/home/user/code' });
      expect(selected).toBe('/home/user/code/my-project');
      expect(mocks.showOpenDialog).toHaveBeenCalledWith(
        expect.objectContaining({
          defaultPath: '/home/user/code',
          properties: ['openDirectory', 'createDirectory'],
        }),
      );
    });

    it('catches dialog exception and translates to INTERNAL_SERVER_ERROR', async () => {
      mocks.showOpenDialog.mockRejectedValueOnce(
        new Error('Gtk-Message: Failed to open native file chooser dialog'),
      );

      await expect(client.selectDirectory()).rejects.toMatchObject({
        code: 'INTERNAL_SERVER_ERROR',
        message: expect.stringContaining('Failed to open native file chooser dialog'),
      });
    });

    it('rejects invalid parameters to selectDirectory with BAD_REQUEST', async () => {
      await expect((client.selectDirectory as any)({ defaultPath: 12345 })).rejects.toMatchObject({
        code: 'BAD_REQUEST',
      });
    });
  });

  // =========================================================================
  // Challenge 4: High-Volume Concurrency & Rapid Procedure Invocations
  // =========================================================================
  describe('Challenge 4: High-Volume Concurrency & Rapid Procedure Invocations', () => {
    it('handles 50 concurrent list procedure invocations without locking or data corruption', async () => {
      // Seed 5 workspaces
      for (let i = 0; i < 5; i++) {
        await client.create({
          name: `Concurrent Profile ${i}`,
          accountId: validAccount.id,
          projectPath: `/workspaces/proj-${i}`,
        });
      }

      // 50 rapid parallel list calls
      const calls = Array.from({ length: 50 }, () => client.list());
      const results = await Promise.all(calls);

      expect(results).toHaveLength(50);
      for (const viewList of results) {
        expect(viewList).toHaveLength(5);
        expect(viewList[0].account?.email).toBe('user@example.com');
      }
    });

    it('handles 20 concurrent profile creations with distinct UUIDs and filesystem directories', async () => {
      const calls = Array.from({ length: 20 }, (_, i) =>
        client.create({
          name: `Parallel Workspace ${i}`,
          accountId: validAccount.id,
          projectPath: `/workspaces/parallel-${i}`,
        }),
      );

      const created = await Promise.all(calls);
      expect(created).toHaveLength(20);

      const uniqueIds = new Set(created.map((c) => c.id));
      expect(uniqueIds.size).toBe(20);

      // Verify each directory exists
      for (const p of created) {
        expect(fs.existsSync(p.userDataDir)).toBe(true);
      }
    });

    // Each bounded cycle opens native SQLite connections and creates/removes real directories.
    // The watchdog covers the complete workload when other native suites share the host.
    it('executes 30 rapid sequential create -> read -> update -> delete cycles without leaks', async () => {
      for (let i = 0; i < 30; i++) {
        const created = await client.create({
          name: `Rapid Cycle ${i}`,
          accountId: validAccount.id,
          projectPath: `/workspaces/rapid-${i}`,
        });

        const fetched = await client.get({ id: created.id });
        expect(fetched?.name).toBe(`Rapid Cycle ${i}`);

        const updated = await client.update({
          id: created.id,
          name: `Rapid Renamed ${i}`,
        });
        expect(updated.name).toBe(`Rapid Renamed ${i}`);

        await client.delete({ id: created.id });
        const postDelete = await client.get({ id: created.id });
        expect(postDelete).toBeNull();
        expect(fs.existsSync(created.userDataDir)).toBe(false);
      }

      const remaining = await client.list();
      expect(remaining).toHaveLength(0);
    }, 15000);

    it('allows concurrent reads while mutations are updating SQLite database', async () => {
      const target = await client.create({
        name: 'Interleaved Target',
        accountId: validAccount.id,
        projectPath: '/workspaces/interleaved',
      });

      const promises: Promise<any>[] = [];
      for (let i = 0; i < 15; i++) {
        promises.push(client.update({ id: target.id, name: `Mutated ${i}` }));
        promises.push(client.get({ id: target.id }));
        promises.push(client.list());
      }

      const results = await Promise.allSettled(promises);
      const rejected = results.filter((r) => r.status === 'rejected');
      expect(rejected).toHaveLength(0);
    });
  });

  // =========================================================================
  // Challenge 5: Lifecycle Fault Tolerance & Filesystem Cleanup Edge Cases
  // =========================================================================
  describe('Challenge 5: Lifecycle Fault Tolerance & Filesystem Cleanup Edge Cases', () => {
    it('reports unknown observation and protects deletion when the lifecycle delegate throws', async () => {
      const faultDelegate = {
        getStatuses: vi.fn().mockRejectedValue(new Error('Process probe kernel error')),
        applyUpdate: async (
          _id: string,
          _input: UpdateWorkspaceProfileInput,
          persist: () => Promise<WorkspaceProfile>,
        ) => persist(),
        getStatus: vi.fn().mockRejectedValue(new Error('Process probe kernel error')),
        launch: vi.fn().mockRejectedValue(new Error('Spawn failed')),
        stop: vi.fn().mockRejectedValue(new Error('Kill failed')),
        withStoppedProfile: vi.fn().mockRejectedValue(new Error('Process probe kernel error')),
      };

      const faultService = createTestWorkspaceProfileService({
        profileRepo: WorkspaceProfileRepo,
        cloudAccountRepo,
        lifecycleDelegate: faultDelegate,
      });
      const faultRouter = createTestWorkspaceRouter(faultService);
      const faultClient = createRouterClient(faultRouter);

      const created = await faultClient.create({
        name: 'Fault Profile',
        accountId: validAccount.id,
        projectPath: '/workspaces/fault',
      });

      // list and get must not fail despite delegate error
      const views = await faultClient.list();
      expect(views).toHaveLength(1);
      expect(views[0].status).toEqual({ running: false, unknown: true });

      const view = await faultClient.get({ id: created.id });
      expect(view?.status).toEqual({ running: false, unknown: true });
      await expect(faultClient.delete({ id: created.id, force: true })).rejects.toMatchObject({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Process probe kernel error',
      });
      expect(await WorkspaceProfileRepo.getProfile(created.id)).not.toBeNull();
      expect(fs.existsSync(created.userDataDir)).toBe(true);
    });

    it('stops running process before deletion when delegate reports running: true', async () => {
      let isRunning = true;
      const stopSpy = vi.fn().mockImplementation(async () => {
        isRunning = false;
      });

      const activeService = createTestWorkspaceProfileService({
        profileRepo: WorkspaceProfileRepo,
        cloudAccountRepo,
        lifecycleDelegate: {
          getStatuses: async (profiles: WorkspaceProfile[]) =>
            profiles.map(() => ({ running: false })),
          applyUpdate: async (
            _id: string,
            _input: UpdateWorkspaceProfileInput,
            persist: () => Promise<WorkspaceProfile>,
          ) => persist(),
          getStatus: vi.fn().mockImplementation(async () => ({ running: isRunning, pid: 9999 })),
          launch: vi.fn().mockResolvedValue({ pid: 9999 }),
          stop: stopSpy,
          withStoppedProfile: async (id, options, action) => {
            if (isRunning && !options.force) {
              throw new ActiveWorkspaceDeletionError(id);
            }
            if (isRunning) {
              await stopSpy(id);
            }
            await action();
          },
        },
      });
      const activeRouter = createTestWorkspaceRouter(activeService);
      const activeClient = createRouterClient(activeRouter);

      const created = await activeClient.create({
        name: 'Active Profile',
        accountId: validAccount.id,
        projectPath: '/workspaces/active',
      });

      await activeClient.delete({ id: created.id, force: true });
      expect(stopSpy).toHaveBeenCalledWith(created.id);
      expect(await activeClient.get({ id: created.id })).toBeNull();
      expect(fs.existsSync(created.userDataDir)).toBe(false);
    });

    it('preserves userDataDir when cleanUserDataDir is false', async () => {
      const created = await client.create({
        name: 'Preserved Profile',
        accountId: validAccount.id,
        projectPath: '/workspaces/preserve',
      });
      expect(fs.existsSync(created.userDataDir)).toBe(true);

      await client.delete({ id: created.id, cleanUserDataDir: false });
      expect(await client.get({ id: created.id })).toBeNull();
      // Directory on disk preserved
      expect(fs.existsSync(created.userDataDir)).toBe(true);
    });

    it('handles deletion gracefully when userDataDir was already removed on disk', async () => {
      const created = await client.create({
        name: 'Missing Folder Profile',
        accountId: validAccount.id,
        projectPath: '/workspaces/missing-folder',
      });

      fs.rmSync(created.userDataDir, { recursive: true, force: true });
      expect(fs.existsSync(created.userDataDir)).toBe(false);

      await expect(client.delete({ id: created.id })).resolves.toBeUndefined();
      expect(await client.get({ id: created.id })).toBeNull();
    });
  });

  // =========================================================================
  // Challenge 6: Error Envelope & Translation Compliance
  // =========================================================================
  describe('Challenge 6: toWorkspaceORPCError Translation Matrix', () => {
    it('accurately maps all domain and system exceptions to oRPC errors', () => {
      // 1. WorkspaceNotFoundError -> NOT_FOUND
      const notFound = toWorkspaceORPCError(new WorkspaceNotFoundError('ws-id-123'));
      expect(notFound.code).toBe('NOT_FOUND');
      expect(notFound.data).toEqual({ code: 'NOT_FOUND', id: 'ws-id-123' });

      // 2. AccountNotFoundError -> BAD_REQUEST
      const accNotFound = toWorkspaceORPCError(new AccountNotFoundError('acc-id-456'));
      expect(accNotFound.code).toBe('BAD_REQUEST');
      expect(accNotFound.data).toEqual({ code: 'BAD_REQUEST' });

      // 3. ActiveWorkspaceDeletionError -> BAD_REQUEST
      const activeWs = toWorkspaceORPCError(new ActiveWorkspaceDeletionError('ws-id-789'));
      expect(activeWs.code).toBe('BAD_REQUEST');
      expect(activeWs.data).toEqual({ code: 'BAD_REQUEST' });

      // 4. WorkspaceValidationError -> BAD_REQUEST
      const valError = toWorkspaceORPCError(new WorkspaceValidationError('Name invalid'));
      expect(valError.code).toBe('BAD_REQUEST');
      expect(valError.data).toEqual({ code: 'BAD_REQUEST' });

      // 5. WorkspaceDirectoryError -> INTERNAL_SERVER_ERROR
      const dirError = toWorkspaceORPCError(new WorkspaceDirectoryError('/var/bad/path'));
      expect(dirError.code).toBe('INTERNAL_SERVER_ERROR');
      expect(dirError.data).toEqual({
        code: 'DIRECTORY_CREATION_FAILED',
        dirPath: '/var/bad/path',
      });

      // 6. Generic Error -> INTERNAL_SERVER_ERROR
      const genError = toWorkspaceORPCError(new Error('Unexpected file lock timeout'));
      expect(genError.code).toBe('INTERNAL_SERVER_ERROR');
      expect(genError.message).toBe('Unexpected file lock timeout');

      // 7. ORPCError -> Passthrough
      const existingOrpc = new ORPCError('FORBIDDEN', { message: 'Access denied' });
      expect(toWorkspaceORPCError(existingOrpc)).toBe(existingOrpc);
    });
  });
});
