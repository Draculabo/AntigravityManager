import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceProfileRepo } from '@/modules/workspace/persistence/workspace-profile-repo';
import { WorkspaceValidationError, WorkspaceDirectoryError } from '@/modules/workspace/types';
import { getProfileUserDataDir } from '@/shared/platform/paths';
import { createWorkspaceProfileService } from '@/modules/workspace/services/workspace-profile.service';

describe('Adversarial Empirical Stress Testing: M1 Persistence Layer', () => {
  let originalHome: string | undefined;
  let testHomeDir: string;
  let testDbPath: string;
  let testProfilesDir: string;

  beforeEach(() => {
    originalHome = process.env.HOME;
    testHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agm-challenger-m1-'));
    process.env.HOME = testHomeDir;

    testDbPath = path.join(testHomeDir, '.antigravity-agent', 'cloud_accounts.db');
    testProfilesDir = path.join(testHomeDir, '.config', 'AntigravityManager', 'profiles');

    fs.mkdirSync(path.dirname(testDbPath), { recursive: true });
    fs.mkdirSync(testProfilesDir, { recursive: true });

    WorkspaceProfileRepo.setDatabasePath(testDbPath);

    // Initialize cloud DB with required tables and seed account
    const db = new Database(testDbPath);
    db.pragma('journal_mode = WAL');
    db.exec(`
      CREATE TABLE IF NOT EXISTS accounts (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        email TEXT NOT NULL,
        token_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_used INTEGER NOT NULL,
        is_active INTEGER DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
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

      INSERT INTO accounts (id, provider, email, token_json, created_at, last_used, is_active)
      VALUES ('valid-account-1', 'google', 'engineer@example.com', '{}', 1700000000, 1700000000, 1);
    `);
    db.close();
  });

  afterEach(() => {
    WorkspaceProfileRepo.setDatabasePath(null);
    process.env.HOME = originalHome;
    try {
      fs.rmSync(testHomeDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup error
    }
    vi.restoreAllMocks();
  });

  // =========================================================================
  // Challenge 1: Genuine WorkspaceProfileRepo CRUD Baseline
  // =========================================================================
  describe('Challenge 1: Genuine WorkspaceProfileRepo CRUD Operations', () => {
    it('executes full CRUD cycle directly through WorkspaceProfileRepo against real SQLite', async () => {
      // 1. Create
      const created = await WorkspaceProfileRepo.createProfile({
        name: 'Alpha Project',
        accountId: 'valid-account-1',
        projectPath: '/projects/alpha',
      });

      expect(created).toBeDefined();
      expect(created.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(created.name).toBe('Alpha Project');
      expect(created.accountId).toBe('valid-account-1');
      expect(created.projectPath).toBe('/projects/alpha');
      expect(created.lastLaunchedAt).toBeNull();
      // Verify storage dir bootstrapped on disk
      expect(fs.existsSync(path.join(created.userDataDir, 'User', 'globalStorage'))).toBe(true);

      // 2. Read by ID
      const fetched = await WorkspaceProfileRepo.getProfile(created.id);
      expect(fetched).not.toBeNull();
      expect(fetched!.id).toBe(created.id);
      expect(fetched!.name).toBe('Alpha Project');

      // 3. Update mutable fields
      const updated = await WorkspaceProfileRepo.updateProfile({
        id: created.id,
        name: 'Alpha Project Renamed',
        projectPath: '/projects/alpha-v2',
      });
      expect(updated.name).toBe('Alpha Project Renamed');
      expect(updated.projectPath).toBe('/projects/alpha-v2');

      // 4. Update last launched
      const launchedTime = Date.now();
      const afterLaunch = await WorkspaceProfileRepo.updateLastLaunched(created.id, launchedTime);
      expect(afterLaunch.lastLaunchedAt).toBe(launchedTime);

      // 5. List profiles
      const list = await WorkspaceProfileRepo.listProfiles();
      expect(list.length).toBe(1);
      expect(list[0].id).toBe(created.id);

      // 6. Query by account ID
      const byAcc = await WorkspaceProfileRepo.getProfilesByAccountId('valid-account-1');
      expect(byAcc.length).toBe(1);

      // 7. Delete profile
      const deleted = await WorkspaceProfileRepo.deleteProfile(created.id);
      expect(deleted).toBe(true);

      const afterDelete = await WorkspaceProfileRepo.getProfile(created.id);
      expect(afterDelete).toBeNull();
    });
  });

  // =========================================================================
  // Challenge 2: Path Traversal & Filesystem Boundary Violation
  // =========================================================================
  describe('Challenge 2: Path Traversal & Filesystem Safety', () => {
    it('strictly rejects path traversal strings ("..", ".", and escaping paths) in getProfileUserDataDir', () => {
      // Case 1: Traversal using ".." throws error
      expect(() => getProfileUserDataDir('..')).toThrow(/Invalid workspace profile ID/);

      // Case 2: Traversal using "." throws error
      expect(() => getProfileUserDataDir('.')).toThrow(/Invalid workspace profile ID/);

      // Case 3: Traversal with path prefix "../victim" throws error
      expect(() => getProfileUserDataDir('../victim')).toThrow(/Invalid workspace profile ID/);
    });

    it('strictly enforces absolute projectPath in WorkspaceProfileRepo.createProfile', async () => {
      // Relative project paths must be rejected with WorkspaceValidationError
      await expect(
        WorkspaceProfileRepo.createProfile({
          name: 'Relative Path Project',
          accountId: 'valid-account-1',
          projectPath: './relative/path/somewhere',
        }),
      ).rejects.toThrow(WorkspaceValidationError);
    });

    it('strictly rejects arbitrary userDataDir outside the profiles base directory', async () => {
      const outsideTarget = path.join(testHomeDir, 'arbitrary-victim-dir');

      await expect(
        WorkspaceProfileRepo.createProfile(
          {
            name: 'Arbitrary Dir Profile',
            accountId: 'valid-account-1',
            projectPath: '/tmp/proj',
          },
          { userDataDir: outsideTarget },
        ),
      ).rejects.toThrow(WorkspaceValidationError);
    });

    it('strictly prevents unconstrained userDataDir deletion outside profiles directory', async () => {
      const sensitiveDir = path.join(testHomeDir, 'sensitive-directory');
      fs.mkdirSync(sensitiveDir, { recursive: true });
      fs.writeFileSync(path.join(sensitiveDir, 'passwords.txt'), 'secret');

      const mockRepo = {
        ...WorkspaceProfileRepo,
        getProfile: vi.fn(async (id: string) => ({
          id,
          name: 'Malicious Profile',
          accountId: 'valid-account-1',
          projectPath: '/tmp/proj',
          userDataDir: sensitiveDir,
          createdAt: Date.now(),
          lastLaunchedAt: null,
        })),
        deleteProfile: vi.fn(async () => true),
      };

      const testService = createWorkspaceProfileService({
        profileRepo: mockRepo as any,
        cloudAccountRepo: {
          getAccounts: async () => [],
          getAccount: async () => null,
        },
      });

      // Deleting a profile pointing outside the profiles directory must fail and protect files
      await expect(testService.delete('222e4567-e89b-12d3-a456-426614174000')).rejects.toThrow(
        WorkspaceDirectoryError,
      );

      // Sensitive directory remains intact!
      expect(fs.existsSync(sensitiveDir)).toBe(true);
      expect(fs.existsSync(path.join(sensitiveDir, 'passwords.txt'))).toBe(true);
    });
  });

  // =========================================================================
  // Challenge 3: Schema Resilience Against Corrupted / Malformed Database Rows
  // =========================================================================
  describe('Challenge 3: Blast Radius of Malformed Database Rows', () => {
    it('quarantines corrupted row (e.g. empty name) so listProfiles() continues to return healthy profiles', async () => {
      // 1. Create a valid profile first
      const valid = await WorkspaceProfileRepo.createProfile({
        name: 'Valid Workspace 1',
        accountId: 'valid-account-1',
        projectPath: '/tmp/proj1',
      });

      // 2. Corrupt database directly by inserting a row with empty name
      const db = new Database(testDbPath);
      db.prepare(
        `
        INSERT INTO workspace_profiles (id, name, account_id, project_path, user_data_dir, created_at, last_launched_at)
        VALUES ('222e4567-e89b-12d3-a456-426614174000', '', 'valid-account-1', '/tmp/p2', '/tmp/u2', 1700000000, NULL)
      `,
      ).run();
      db.close();

      // 3. listProfiles() must quarantine the corrupt row and return the valid profile cleanly
      const list = await WorkspaceProfileRepo.listProfiles();
      expect(list).toHaveLength(1);
      expect(list[0].id).toBe(valid.id);
      expect(list[0].name).toBe('Valid Workspace 1');
    });

    it('quarantines non-UUID row so listProfiles() does not crash', async () => {
      const db = new Database(testDbPath);
      db.prepare(
        `
        INSERT INTO workspace_profiles (id, name, account_id, project_path, user_data_dir, created_at, last_launched_at)
        VALUES ('legacy-id-123', 'Legacy Profile', 'valid-account-1', '/tmp/p3', '/tmp/u3', 1700000000, NULL)
      `,
      ).run();
      db.close();

      // listProfiles() gracefully skips non-UUID row without throwing
      const list = await WorkspaceProfileRepo.listProfiles();
      expect(Array.isArray(list)).toBe(true);
      expect(list).toHaveLength(0);
    });
  });

  // =========================================================================
  // Challenge 4: Transaction Atomicity & State Corruption
  // =========================================================================
  describe('Challenge 4: Transaction Atomicity & Rollback', () => {
    it('does not leave orphaned directories on disk when entity validation fails in createProfile', async () => {
      const invalidId = 'not-a-valid-uuid';
      const expectedStorageDir = path.join(testProfilesDir, invalidId, 'User', 'globalStorage');

      // Attempt to create with invalid UUID
      await expect(
        WorkspaceProfileRepo.createProfile(
          {
            name: 'Failing Profile',
            accountId: 'valid-account-1',
            projectPath: '/tmp/proj',
          },
          { id: invalidId },
        ),
      ).rejects.toThrow();

      // Directory must NOT exist on disk
      expect(fs.existsSync(expectedStorageDir)).toBe(false);
    });

    it('validates update before DB mutation, preventing permanent row corruption on validation failure', async () => {
      const profile = await WorkspaceProfileRepo.createProfile({
        name: 'Original Valid Profile',
        accountId: 'valid-account-1',
        projectPath: '/tmp/proj',
      });

      // Attempt update with empty name
      await expect(
        WorkspaceProfileRepo.updateProfile({
          id: profile.id,
          name: '',
        }),
      ).rejects.toThrow();

      // Inspect SQLite database directly
      const db = new Database(testDbPath);
      const row = db
        .prepare('SELECT name FROM workspace_profiles WHERE id = ?')
        .get(profile.id) as any;
      db.close();

      // Database was NOT modified to ''
      expect(row.name).toBe('Original Valid Profile');

      // getProfile remains functional and intact
      const fetched = await WorkspaceProfileRepo.getProfile(profile.id);
      expect(fetched).not.toBeNull();
      expect(fetched!.name).toBe('Original Valid Profile');
    });

    it('enforces UNIQUE constraint on duplicate UUID insertion in SQLite', async () => {
      const dupId = crypto.randomUUID();
      await WorkspaceProfileRepo.createProfile(
        {
          name: 'First Instance',
          accountId: 'valid-account-1',
          projectPath: '/tmp/p1',
        },
        { id: dupId },
      );

      // Second creation with duplicate ID must fail with SQLite UNIQUE constraint
      await expect(
        WorkspaceProfileRepo.createProfile(
          {
            name: 'Second Instance',
            accountId: 'valid-account-1',
            projectPath: '/tmp/p2',
          },
          { id: dupId },
        ),
      ).rejects.toThrow(/UNIQUE constraint failed/i);
    });
  });

  // =========================================================================
  // Challenge 5: Concurrency & Lock Stress Testing
  // =========================================================================
  describe('Challenge 5: Concurrency Stress Testing', () => {
    it('handles 20 concurrent createProfile operations without SQLITE_BUSY deadlocks', async () => {
      const count = 20;
      const tasks = Array.from({ length: count }, (_, i) =>
        WorkspaceProfileRepo.createProfile({
          name: `Concurrent Profile ${i}`,
          accountId: 'valid-account-1',
          projectPath: `/tmp/concurrent-${i}`,
        }),
      );

      const results = await Promise.all(tasks);
      expect(results.length).toBe(count);

      const all = await WorkspaceProfileRepo.listProfiles();
      expect(all.length).toBe(count);
    });

    it('handles 30 mixed concurrent read/write/update operations without deadlocks', async () => {
      // Create 5 baseline profiles
      const initial = await Promise.all(
        Array.from({ length: 5 }, (_, i) =>
          WorkspaceProfileRepo.createProfile({
            name: `Base ${i}`,
            accountId: 'valid-account-1',
            projectPath: `/tmp/base-${i}`,
          }),
        ),
      );

      const operations: Promise<any>[] = [];

      // 10 concurrent reads
      for (let i = 0; i < 10; i++) {
        operations.push(WorkspaceProfileRepo.listProfiles());
        operations.push(WorkspaceProfileRepo.getProfile(initial[i % 5].id));
      }

      // 5 concurrent updates
      for (let i = 0; i < 5; i++) {
        operations.push(
          WorkspaceProfileRepo.updateProfile({
            id: initial[i].id,
            name: `Updated Base ${i}`,
          }),
        );
      }

      // 5 concurrent creates
      for (let i = 0; i < 5; i++) {
        operations.push(
          WorkspaceProfileRepo.createProfile({
            name: `New Mixed ${i}`,
            accountId: 'valid-account-1',
            projectPath: `/tmp/mixed-${i}`,
          }),
        );
      }

      const results = await Promise.allSettled(operations);
      const rejected = results.filter((r) => r.status === 'rejected');
      expect(rejected).toHaveLength(0);
    });
  });

  // =========================================================================
  // Challenge 6: SQLite Foreign Key Enforcement
  // =========================================================================
  describe('Challenge 6: Referential Integrity', () => {
    it('OBSERVATION: SQLite schema lacks FOREIGN KEY constraint on account_id', async () => {
      // Direct insertion via WorkspaceProfileRepo with non-existent account ID
      const phantomAccProfile = await WorkspaceProfileRepo.createProfile({
        name: 'Orphaned Workspace',
        accountId: 'phantom-account-999',
        projectPath: '/tmp/phantom',
      });

      expect(phantomAccProfile.accountId).toBe('phantom-account-999');

      // Verify row exists in DB referencing a non-existent account
      const db = new Database(testDbPath);
      const row = db
        .prepare('SELECT * FROM workspace_profiles WHERE id = ?')
        .get(phantomAccProfile.id) as any;
      const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get('phantom-account-999');
      db.close();

      expect(row).toBeDefined();
      expect(account).toBeUndefined();
    });
  });

  // =========================================================================
  // Challenge 7: Runtime Module Portability & Transitive Dependencies
  // =========================================================================
  describe('Challenge 7: Runtime Module Portability in Node 26 Strip-Only Environment', () => {
    it('WorkspaceProfileService can be imported in Node 26 cleanly without keytar-provider parameter properties error', async () => {
      const mod = await import('@/modules/workspace/services/workspace-profile.service');
      expect(mod.WorkspaceProfileService).toBeDefined();
    });

    it('workspaceRouter can be imported in Node 26 cleanly without keytar-provider parameter properties error', async () => {
      const mod = await import('@/modules/workspace/ipc/router');
      expect(mod.workspaceRouter).toBeDefined();
    });
  });
});
