import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { WorkspaceProfileRepo } from '@/modules/workspace/persistence/workspace-profile-repo';
import { WorkspaceProfileNotFoundError, WorkspaceValidationError } from '@/modules/workspace/types';
import { getProfilesBaseDir } from '@/shared/platform/paths';

const fixturePaths = vi.hoisted(() => ({ root: '' }));

// Keep filesystem effects in this fixture while retaining production profile-ID validation.
vi.mock('@/shared/platform/paths', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/shared/platform/paths')>();
  return {
    ...actual,
    getProfilesBaseDir: () => path.join(fixturePaths.root, 'profiles'),
    getProfileUserDataDir: (profileId: string) =>
      path.join(
        fixturePaths.root,
        'profiles',
        path.basename(actual.getProfileUserDataDir(profileId, { isWsl: false })),
      ),
  };
});

// Un-mock better-sqlite3 for genuine SQLite persistence
vi.mock('better-sqlite3', async () => {
  const { createRequire } = await import('node:module');
  return { default: createRequire(import.meta.url)('better-sqlite3') };
});

describe('Workspace Profile Persistence (R1) - Genuine Repository Tests', () => {
  let tempDir: string;
  let testDbPath: string;
  let baseProfilesDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agm-repo-test-'));
    fixturePaths.root = tempDir;
    testDbPath = path.join(tempDir, 'cloud_accounts.db');
    baseProfilesDir = getProfilesBaseDir();

    WorkspaceProfileRepo.setDatabasePath(testDbPath);

    // Bootstrap test database schema
    const db = new Database(testDbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 3000');
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
      VALUES ('account-101', 'google', 'user@example.com', '{}', 1700000000, 1700000000, 1);
      INSERT INTO accounts (id, provider, email, token_json, created_at, last_used, is_active)
      VALUES ('account-102', 'google', 'second@example.com', '{}', 1700000000, 1700000000, 0);
    `);
    db.close();
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
  // 1. WorkspaceProfileRepo.createProfile
  // =========================================================================
  describe('WorkspaceProfileRepo.createProfile', () => {
    it('creates a workspace profile with generated UUID and bootstraps storage directory', async () => {
      const created = await WorkspaceProfileRepo.createProfile({
        name: 'Alpha Project',
        accountId: 'account-101',
        projectPath: '/projects/alpha',
      });

      expect(created).toBeDefined();
      expect(created.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(created.name).toBe('Alpha Project');
      expect(created.accountId).toBe('account-101');
      expect(created.projectPath).toBe('/projects/alpha');
      expect(created.createdAt).toBeGreaterThan(0);
      expect(created.lastLaunchedAt).toBeNull();

      // Verify directory structure on disk
      const globalStorage = path.join(created.userDataDir, 'User', 'globalStorage');
      expect(fs.existsSync(globalStorage)).toBe(true);

      // Verify row persisted to SQLite directly
      const db = new Database(testDbPath);
      const row = db
        .prepare('SELECT * FROM workspace_profiles WHERE id = ?')
        .get(created.id) as any;
      db.close();

      expect(row).toBeDefined();
      expect(row.name).toBe('Alpha Project');
      expect(row.account_id).toBe('account-101');
    });

    it('creates profile with custom valid UUID', async () => {
      const customId = crypto.randomUUID();
      const created = await WorkspaceProfileRepo.createProfile(
        {
          name: 'Custom ID Project',
          accountId: 'account-101',
          projectPath: '/projects/custom',
        },
        { id: customId },
      );

      expect(created.id).toBe(customId);
    });

    it('rejects relative projectPath with WorkspaceValidationError', async () => {
      await expect(
        WorkspaceProfileRepo.createProfile({
          name: 'Invalid Path Project',
          accountId: 'account-101',
          projectPath: './relative/path',
        }),
      ).rejects.toThrow(WorkspaceValidationError);
    });

    it('rejects custom userDataDir that escapes base profiles directory', async () => {
      await expect(
        WorkspaceProfileRepo.createProfile(
          {
            name: 'Escaping Dir Project',
            accountId: 'account-101',
            projectPath: '/projects/escape',
          },
          { userDataDir: '/etc/unsafe-path' },
        ),
      ).rejects.toThrow(WorkspaceValidationError);
    });

    it('enforces UNIQUE constraint on duplicate UUID creation', async () => {
      const duplicateId = crypto.randomUUID();

      await WorkspaceProfileRepo.createProfile(
        {
          name: 'First Instance',
          accountId: 'account-101',
          projectPath: '/projects/p1',
        },
        { id: duplicateId },
      );

      await expect(
        WorkspaceProfileRepo.createProfile(
          {
            name: 'Duplicate Instance',
            accountId: 'account-101',
            projectPath: '/projects/p2',
          },
          { id: duplicateId },
        ),
      ).rejects.toThrow(/UNIQUE constraint failed/i);
    });

    it('rolls back bootstrapped directory on disk if insertion fails', async () => {
      const existingId = crypto.randomUUID();
      await WorkspaceProfileRepo.createProfile(
        {
          name: 'Existing Instance',
          accountId: 'account-101',
          projectPath: '/projects/existing',
        },
        { id: existingId },
      );

      // Attempt second creation with same ID but different userDataDir
      const failingUserDataDir = path.join(baseProfilesDir, crypto.randomUUID());

      await expect(
        WorkspaceProfileRepo.createProfile(
          {
            name: 'Failing Instance',
            accountId: 'account-101',
            projectPath: '/projects/fail',
          },
          { id: existingId, userDataDir: failingUserDataDir },
        ),
      ).rejects.toThrow();

      // The failing directory should be rolled back and cleaned up
      expect(fs.existsSync(failingUserDataDir)).toBe(false);
    });
  });

  // =========================================================================
  // 2. WorkspaceProfileRepo.getProfile
  // =========================================================================
  describe('WorkspaceProfileRepo.getProfile', () => {
    it('retrieves profile by ID accurately', async () => {
      const created = await WorkspaceProfileRepo.createProfile({
        name: 'Target Profile',
        accountId: 'account-101',
        projectPath: '/projects/target',
      });

      const fetched = await WorkspaceProfileRepo.getProfile(created.id);
      expect(fetched).not.toBeNull();
      expect(fetched!.id).toBe(created.id);
      expect(fetched!.name).toBe('Target Profile');
      expect(fetched!.accountId).toBe('account-101');
      expect(fetched!.projectPath).toBe('/projects/target');
    });

    it('returns null when profile does not exist', async () => {
      const fetched = await WorkspaceProfileRepo.getProfile(crypto.randomUUID());
      expect(fetched).toBeNull();
    });
  });

  // =========================================================================
  // 3. WorkspaceProfileRepo.listProfiles
  // =========================================================================
  describe('WorkspaceProfileRepo.listProfiles', () => {
    it('returns profiles sorted by creation timestamp descending', async () => {
      const p1 = await WorkspaceProfileRepo.createProfile({
        name: 'Profile 1',
        accountId: 'account-101',
        projectPath: '/projects/p1',
      });

      // Small delay to ensure timestamp progression
      await new Promise((r) => setTimeout(r, 10));

      const p2 = await WorkspaceProfileRepo.createProfile({
        name: 'Profile 2',
        accountId: 'account-101',
        projectPath: '/projects/p2',
      });

      const list = await WorkspaceProfileRepo.listProfiles();
      expect(list.length).toBe(2);
      expect(list[0].id).toBe(p2.id); // Newest first
      expect(list[1].id).toBe(p1.id);
    });

    it('quarantines corrupt rows and returns all valid profiles without crashing', async () => {
      const valid = await WorkspaceProfileRepo.createProfile({
        name: 'Healthy Profile',
        accountId: 'account-101',
        projectPath: '/projects/healthy',
      });

      // Directly insert corrupted row (empty name, non-UUID id)
      const db = new Database(testDbPath);
      db.prepare(
        `
        INSERT INTO workspace_profiles (id, name, account_id, project_path, user_data_dir, created_at, last_launched_at)
        VALUES ('corrupt-row-id', '', 'account-101', '/projects/bad', '/tmp/bad', 1700000000, NULL)
      `,
      ).run();
      db.close();

      const list = await WorkspaceProfileRepo.listProfiles();
      // Must NOT throw, and must return the 1 healthy profile
      expect(list).toHaveLength(1);
      expect(list[0].id).toBe(valid.id);
      expect(list[0].name).toBe('Healthy Profile');
    });
  });

  // =========================================================================
  // 4. WorkspaceProfileRepo.updateProfile
  // =========================================================================
  describe('WorkspaceProfileRepo.updateProfile', () => {
    it('updates mutable fields atomically', async () => {
      const created = await WorkspaceProfileRepo.createProfile({
        name: 'Initial Name',
        accountId: 'account-101',
        projectPath: '/projects/init',
      });

      const updated = await WorkspaceProfileRepo.updateProfile({
        id: created.id,
        name: 'Renamed Name',
        accountId: 'account-102',
        projectPath: '/projects/renamed',
      });

      expect(updated.name).toBe('Renamed Name');
      expect(updated.accountId).toBe('account-102');
      expect(updated.projectPath).toBe('/projects/renamed');

      const fetched = await WorkspaceProfileRepo.getProfile(created.id);
      expect(fetched!.name).toBe('Renamed Name');
    });

    it('rejects relative projectPath without corrupting the existing row in SQLite', async () => {
      const created = await WorkspaceProfileRepo.createProfile({
        name: 'Safe Profile',
        accountId: 'account-101',
        projectPath: '/projects/safe',
      });

      await expect(
        WorkspaceProfileRepo.updateProfile({
          id: created.id,
          projectPath: './relative/path',
        }),
      ).rejects.toThrow(WorkspaceValidationError);

      // Verify row in SQLite was NOT corrupted
      const fetched = await WorkspaceProfileRepo.getProfile(created.id);
      expect(fetched!.projectPath).toBe('/projects/safe');
    });

    it('rejects empty name without corrupting the existing row in SQLite', async () => {
      const created = await WorkspaceProfileRepo.createProfile({
        name: 'Valid Name',
        accountId: 'account-101',
        projectPath: '/projects/valid',
      });

      await expect(
        WorkspaceProfileRepo.updateProfile({
          id: created.id,
          name: '',
        }),
      ).rejects.toThrow();

      // Verify row in SQLite was preserved
      const fetched = await WorkspaceProfileRepo.getProfile(created.id);
      expect(fetched!.name).toBe('Valid Name');
    });

    it('throws WorkspaceProfileNotFoundError when updating non-existent ID', async () => {
      await expect(
        WorkspaceProfileRepo.updateProfile({
          id: crypto.randomUUID(),
          name: 'Non Existent',
        }),
      ).rejects.toThrow(WorkspaceProfileNotFoundError);
    });
  });

  // =========================================================================
  // 5. WorkspaceProfileRepo.updateLastLaunched
  // =========================================================================
  describe('WorkspaceProfileRepo.updateLastLaunched', () => {
    it('updates lastLaunchedAt timestamp in SQLite', async () => {
      const created = await WorkspaceProfileRepo.createProfile({
        name: 'Launch Tracker',
        accountId: 'account-101',
        projectPath: '/projects/tracker',
      });
      expect(created.lastLaunchedAt).toBeNull();

      const timestamp = 1709999999;
      const updated = await WorkspaceProfileRepo.updateLastLaunched(created.id, timestamp);
      expect(updated.lastLaunchedAt).toBe(timestamp);

      const fetched = await WorkspaceProfileRepo.getProfile(created.id);
      expect(fetched!.lastLaunchedAt).toBe(timestamp);
    });

    it('throws WorkspaceProfileNotFoundError for non-existent ID', async () => {
      await expect(WorkspaceProfileRepo.updateLastLaunched(crypto.randomUUID())).rejects.toThrow(
        WorkspaceProfileNotFoundError,
      );
    });
  });

  // =========================================================================
  // 6. WorkspaceProfileRepo.getProfilesByAccountId
  // =========================================================================
  describe('WorkspaceProfileRepo.getProfilesByAccountId', () => {
    it('finds profiles associated with a given account ID', async () => {
      await WorkspaceProfileRepo.createProfile({
        name: 'Acc 101 - A',
        accountId: 'account-101',
        projectPath: '/projects/a',
      });
      await WorkspaceProfileRepo.createProfile({
        name: 'Acc 101 - B',
        accountId: 'account-101',
        projectPath: '/projects/b',
      });
      await WorkspaceProfileRepo.createProfile({
        name: 'Acc 102 - C',
        accountId: 'account-102',
        projectPath: '/projects/c',
      });

      const acc101Profiles = await WorkspaceProfileRepo.getProfilesByAccountId('account-101');
      expect(acc101Profiles).toHaveLength(2);

      const acc102Profiles = await WorkspaceProfileRepo.getProfilesByAccountId('account-102');
      expect(acc102Profiles).toHaveLength(1);

      const empty = await WorkspaceProfileRepo.getProfilesByAccountId('account-unknown');
      expect(empty).toHaveLength(0);
    });
  });

  // =========================================================================
  // 7. WorkspaceProfileRepo.deleteProfile
  // =========================================================================
  describe('WorkspaceProfileRepo.deleteProfile', () => {
    it('deletes profile row from database and returns true', async () => {
      const created = await WorkspaceProfileRepo.createProfile({
        name: 'To Delete',
        accountId: 'account-101',
        projectPath: '/projects/delete',
      });

      const deleted = await WorkspaceProfileRepo.deleteProfile(created.id);
      expect(deleted).toBe(true);

      const fetched = await WorkspaceProfileRepo.getProfile(created.id);
      expect(fetched).toBeNull();
    });

    it('returns false when attempting to delete non-existent profile ID', async () => {
      const deleted = await WorkspaceProfileRepo.deleteProfile(crypto.randomUUID());
      expect(deleted).toBe(false);
    });
  });

  // =========================================================================
  // 8. Concurrency & Integrity
  // =========================================================================
  describe('WorkspaceProfileRepo Concurrency', () => {
    it('handles 10 concurrent createProfile operations without SQLITE_BUSY deadlocks', async () => {
      const tasks = Array.from({ length: 10 }, (_, i) =>
        WorkspaceProfileRepo.createProfile({
          name: `Concurrent Profile ${i}`,
          accountId: 'account-101',
          projectPath: `/projects/concurrent-${i}`,
        }),
      );

      const created = await Promise.all(tasks);
      expect(created).toHaveLength(10);

      const list = await WorkspaceProfileRepo.listProfiles();
      expect(list).toHaveLength(10);
    });
  });
});
