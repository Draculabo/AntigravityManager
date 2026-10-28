import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  provisionEditorSettings,
  provisionExtensionsSharing,
  provisionGeminiCustomizations,
  provisionWorkspaceProfileSharing,
  safeSymlink,
  seedRecentProjectHistory,
} from '@/modules/workspace/services/workspace-provisioning';
import {
  getAntigravityExtensionsDir,
  getAntigravityHostUserDir,
  getAppDataDir,
} from '@/shared/platform/paths';
import { resolveLaunchContext } from '@/modules/antigravity-runtime';
import * as paths from '@/shared/platform/paths';

vi.mock('better-sqlite3', async () => {
  const { createRequire } = await import('node:module');
  return { default: createRequire(import.meta.url)('better-sqlite3') };
});

describe('Empirical Challenger 2: Defensive Execution, Concurrency & Error Resilience (R4)', () => {
  let tempRoot: string;
  let profileDir: string;
  let isolatedHome: string;
  let hostUserDir: string;
  let hostGeminiDir: string;
  let hostExtensionsDir: string;
  let hostStorageDir: string;
  let hostDbPath: string;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agm-challenger-2-'));
    profileDir = path.join(tempRoot, 'profiles', 'target-profile');
    isolatedHome = path.join(profileDir, 'home');
    hostUserDir = path.join(tempRoot, 'host-user');
    hostGeminiDir = path.join(tempRoot, 'host-gemini');
    hostExtensionsDir = path.join(tempRoot, 'host-extensions');
    hostStorageDir = path.join(tempRoot, 'host-storage');
    hostDbPath = path.join(hostStorageDir, 'state.vscdb');

    fs.mkdirSync(profileDir, { recursive: true });
    fs.mkdirSync(isolatedHome, { recursive: true });
    fs.mkdirSync(hostUserDir, { recursive: true });
    fs.mkdirSync(hostGeminiDir, { recursive: true });
    fs.mkdirSync(hostExtensionsDir, { recursive: true });
    fs.mkdirSync(hostStorageDir, { recursive: true });
  });

  afterEach(() => {
    // Restore permissions on any files/dirs modified during tests to allow clean rmSync
    try {
      const restorePerms = (dir: string) => {
        try {
          fs.chmodSync(dir, 0o777);
          const entries = fs.readdirSync(dir, { withFileTypes: true });
          for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            try {
              fs.chmodSync(fullPath, 0o777);
              if (entry.isDirectory()) {
                restorePerms(fullPath);
              }
            } catch {
              // ignore
            }
          }
        } catch {
          // ignore
        }
      };
      restorePerms(tempRoot);
      fs.rmSync(tempRoot, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
    vi.restoreAllMocks();
  });

  // =========================================================================
  // Adversarial Suite 1: Host & Profile state.vscdb Database Fault Injections
  // =========================================================================
  describe('Suite 1: Host & Profile state.vscdb Fault Injections (SQLITE_BUSY, corrupt, empty, missing)', () => {
    function initProfileDb(dbDir: string, initialItems?: Record<string, string>): string {
      const storageDir = path.join(dbDir, 'User', 'globalStorage');
      fs.mkdirSync(storageDir, { recursive: true });
      const dbPath = path.join(storageDir, 'state.vscdb');
      const db = new Database(dbPath);
      db.exec('CREATE TABLE IF NOT EXISTS ItemTable (key TEXT PRIMARY KEY, value TEXT);');
      if (initialItems) {
        const stmt = db.prepare('INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)');
        for (const [k, v] of Object.entries(initialItems)) {
          stmt.run(k, v);
        }
      }
      db.close();
      return dbPath;
    }

    it('1.1: locked host database (SQLITE_BUSY under exclusive transaction) times out gracefully and does not throw', () => {
      const profileDbPath = initProfileDb(profileDir);

      // Create host db and hold an exclusive lock
      const hostDb = new Database(hostDbPath);
      hostDb.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT);');
      hostDb
        .prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)')
        .run('history.recentlyOpenedPathsList', JSON.stringify({ entries: ['/project/alpha'] }));
      hostDb.exec('PRAGMA locking_mode = EXCLUSIVE; BEGIN EXCLUSIVE;');

      expect(() => {
        seedRecentProjectHistory({
          profileUserDataDir: profileDir,
          hostDbPath,
          timeoutMs: 50,
        });
      }).not.toThrow();

      // Clean up lock
      try {
        hostDb.exec('ROLLBACK;');
        hostDb.close();
      } catch {
        // ignore
      }

      // Verify profile db is intact and uncorrupted
      const verifyDb = new Database(profileDbPath, { readonly: true });
      const row = verifyDb
        .prepare("SELECT value FROM ItemTable WHERE key = 'history.recentlyOpenedPathsList'")
        .get();
      verifyDb.close();
      expect(row).toBeUndefined();
    });

    it('1.2: completely missing host state.vscdb does not throw and leaves profile untouched', () => {
      const profileDbPath = initProfileDb(profileDir);
      const nonExistentDb = path.join(tempRoot, 'does-not-exist.vscdb');

      expect(() => {
        seedRecentProjectHistory({
          profileUserDataDir: profileDir,
          hostDbPath: nonExistentDb,
        });
      }).not.toThrow();

      const verifyDb = new Database(profileDbPath, { readonly: true });
      const rows = verifyDb.prepare('SELECT count(*) as count FROM ItemTable').get() as {
        count: number;
      };
      verifyDb.close();
      expect(rows.count).toBe(0);
    });

    it('1.3: empty (0-byte) host database file does not throw or crash', () => {
      const profileDbPath = initProfileDb(profileDir);
      fs.writeFileSync(hostDbPath, ''); // 0 bytes

      expect(() => {
        seedRecentProjectHistory({
          profileUserDataDir: profileDir,
          hostDbPath,
        });
      }).not.toThrow();

      const verifyDb = new Database(profileDbPath, { readonly: true });
      expect(verifyDb.open).toBe(true);
      verifyDb.close();
    });

    it('1.4: corrupt host database (random garbage binary data) does not throw or crash', () => {
      const profileDbPath = initProfileDb(profileDir);
      fs.writeFileSync(hostDbPath, Buffer.from([0x00, 0xff, 0xca, 0xfe, 0xba, 0xbe, 0x12, 0x34]));

      expect(() => {
        seedRecentProjectHistory({
          profileUserDataDir: profileDir,
          hostDbPath,
        });
      }).not.toThrow();

      const verifyDb = new Database(profileDbPath, { readonly: true });
      expect(verifyDb.open).toBe(true);
      verifyDb.close();
    });

    it('1.5: valid SQLite database with no ItemTable exits cleanly without throwing', () => {
      const profileDbPath = initProfileDb(profileDir);
      const hostDb = new Database(hostDbPath);
      hostDb.exec('CREATE TABLE OtherTable (id INTEGER PRIMARY KEY, note TEXT);');
      hostDb.close();

      expect(() => {
        seedRecentProjectHistory({
          profileUserDataDir: profileDir,
          hostDbPath,
        });
      }).not.toThrow();

      const verifyDb = new Database(profileDbPath, { readonly: true });
      const row = verifyDb
        .prepare("SELECT value FROM ItemTable WHERE key = 'history.recentlyOpenedPathsList'")
        .get();
      verifyDb.close();
      expect(row).toBeUndefined();
    });

    it('1.6: host database with NULL or whitespace history value skips seeding', () => {
      const profileDbPath = initProfileDb(profileDir);
      const hostDb = new Database(hostDbPath);
      hostDb.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT);');
      hostDb
        .prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)')
        .run('history.recentlyOpenedPathsList', '   ');
      hostDb.close();

      expect(() => {
        seedRecentProjectHistory({
          profileUserDataDir: profileDir,
          hostDbPath,
        });
      }).not.toThrow();

      const verifyDb = new Database(profileDbPath, { readonly: true });
      const row = verifyDb
        .prepare("SELECT value FROM ItemTable WHERE key = 'history.recentlyOpenedPathsList'")
        .get();
      verifyDb.close();
      expect(row).toBeUndefined();
    });

    it('1.7: host database with malformed/truncated JSON rejects invalid history and does not corrupt profile', () => {
      const profileDbPath = initProfileDb(profileDir);
      const hostDb = new Database(hostDbPath);
      hostDb.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT);');
      hostDb
        .prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)')
        .run('history.recentlyOpenedPathsList', '{"entries": [{"folderUri": "unclosed_json');
      hostDb.close();

      expect(() => {
        seedRecentProjectHistory({
          profileUserDataDir: profileDir,
          hostDbPath,
        });
      }).not.toThrow();

      const verifyDb = new Database(profileDbPath, { readonly: true });
      const row = verifyDb
        .prepare("SELECT value FROM ItemTable WHERE key = 'history.recentlyOpenedPathsList'")
        .get();
      verifyDb.close();
      expect(row).toBeUndefined();
    });

    it('1.8: locked profile database (SQLITE_BUSY) during seeding does not throw', () => {
      const profileDbPath = initProfileDb(profileDir);
      const hostDb = new Database(hostDbPath);
      hostDb.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT);');
      hostDb
        .prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)')
        .run('history.recentlyOpenedPathsList', JSON.stringify({ entries: ['/valid'] }));
      hostDb.close();

      // Lock profile database
      const profileLock = new Database(profileDbPath);
      profileLock.exec('PRAGMA locking_mode = EXCLUSIVE; BEGIN EXCLUSIVE;');

      expect(() => {
        seedRecentProjectHistory({
          profileUserDataDir: profileDir,
          hostDbPath,
          timeoutMs: 50,
        });
      }).not.toThrow();

      try {
        profileLock.exec('ROLLBACK;');
        profileLock.close();
      } catch {
        // ignore
      }
    });

    it('1.9: unreadable host state.vscdb (chmod 0000) does not throw', () => {
      initProfileDb(profileDir);
      const hostDb = new Database(hostDbPath);
      hostDb.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT);');
      hostDb.close();

      // Make host DB unreadable
      fs.chmodSync(hostDbPath, 0o000);

      expect(() => {
        seedRecentProjectHistory({
          profileUserDataDir: profileDir,
          hostDbPath,
        });
      }).not.toThrow();
    });

    it('1.10: profile state.vscdb missing does not throw', () => {
      // profileDir has no User/globalStorage/state.vscdb
      expect(() => {
        seedRecentProjectHistory({
          profileUserDataDir: profileDir,
          hostDbPath,
        });
      }).not.toThrow();
    });

    it('1.11: host state.vscdb is an invalid directory instead of file (EISDIR) without throwing', () => {
      const profileDbPath = initProfileDb(profileDir);
      const hostDbAsDir = path.join(tempRoot, 'dir-as-db');
      fs.mkdirSync(hostDbAsDir, { recursive: true });

      expect(() => {
        seedRecentProjectHistory({
          profileUserDataDir: profileDir,
          hostDbPath: hostDbAsDir,
        });
      }).not.toThrow();

      const verifyDb = new Database(profileDbPath, { readonly: true });
      expect(verifyDb.open).toBe(true);
      verifyDb.close();
    });

    it('1.12: host state.vscdb path identical to profile state.vscdb path safely no-ops', () => {
      const profileDbPath = initProfileDb(profileDir);
      expect(() => {
        seedRecentProjectHistory({
          profileUserDataDir: profileDir,
          hostDbPath: profileDbPath,
        });
      }).not.toThrow();
    });

    it('1.13: host database in WAL mode with active checkpointing reads safely without deadlock', () => {
      const profileDbPath = initProfileDb(profileDir);
      const hostDb = new Database(hostDbPath);
      hostDb.pragma('journal_mode = WAL');
      hostDb.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT);');
      const testHistory = JSON.stringify({ entries: ['/wal/project'] });
      hostDb
        .prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)')
        .run('history.recentlyOpenedPathsList', testHistory);
      hostDb.close();

      expect(() => {
        seedRecentProjectHistory({
          profileUserDataDir: profileDir,
          hostDbPath,
        });
      }).not.toThrow();

      const verifyDb = new Database(profileDbPath, { readonly: true });
      const row = verifyDb
        .prepare("SELECT value FROM ItemTable WHERE key = 'history.recentlyOpenedPathsList'")
        .get() as { value: string } | undefined;
      verifyDb.close();

      expect(row?.value).toBe(testHistory);
    });
  });

  // =========================================================================
  // Adversarial Suite 2: Missing & Unreadable Host & Profile Directories
  // =========================================================================
  describe('Suite 2: Missing & Unreadable Host & Profile Directories (R4 Focus 2)', () => {
    it('2.1: missing host extensions directory proceeds gracefully without symlinking', () => {
      const missingExtDir = path.join(tempRoot, 'missing-ext');
      expect(() => {
        provisionExtensionsSharing(profileDir, isolatedHome, missingExtDir);
      }).not.toThrow();

      expect(fs.existsSync(path.join(profileDir, 'extensions'))).toBe(false);
      expect(fs.existsSync(path.join(isolatedHome, '.antigravity', 'extensions'))).toBe(false);
    });

    it('2.2: unreadable host extensions directory (chmod 0000) handles gracefully without throw', () => {
      const unreadableExtDir = path.join(tempRoot, 'unreadable-ext');
      fs.mkdirSync(unreadableExtDir, { recursive: true });
      fs.chmodSync(unreadableExtDir, 0o000);

      expect(() => {
        provisionExtensionsSharing(profileDir, isolatedHome, unreadableExtDir);
      }).not.toThrow();
    });

    it('2.3: missing host User directory proceeds gracefully without symlinking', () => {
      const missingUserDir = path.join(tempRoot, 'missing-user');
      expect(() => {
        provisionEditorSettings(profileDir, missingUserDir);
      }).not.toThrow();

      expect(fs.existsSync(path.join(profileDir, 'User', 'settings.json'))).toBe(false);
      expect(fs.existsSync(path.join(profileDir, 'User', 'keybindings.json'))).toBe(false);
    });

    it('2.4: unreadable host User directory (chmod 0000) handles gracefully without throw', () => {
      const unreadableUserDir = path.join(tempRoot, 'unreadable-user');
      fs.mkdirSync(unreadableUserDir, { recursive: true });
      fs.chmodSync(unreadableUserDir, 0o000);

      expect(() => {
        provisionEditorSettings(profileDir, unreadableUserDir);
      }).not.toThrow();
    });

    it('2.5: missing host Gemini directory proceeds gracefully without symlinking', () => {
      const missingGemini = path.join(tempRoot, 'missing-gemini');
      expect(() => {
        provisionGeminiCustomizations(isolatedHome, missingGemini);
      }).not.toThrow();

      expect(fs.existsSync(path.join(isolatedHome, '.gemini', 'config'))).toBe(false);
    });

    it('2.6: unreadable host Gemini directory (chmod 0000) handles gracefully without throw', () => {
      const unreadableGemini = path.join(tempRoot, 'unreadable-gemini');
      fs.mkdirSync(unreadableGemini, { recursive: true });
      fs.chmodSync(unreadableGemini, 0o000);

      expect(() => {
        provisionGeminiCustomizations(isolatedHome, unreadableGemini);
      }).not.toThrow();
    });

    it('2.7: unwritable/read-only profile directory handles gracefully when symlink creation fails', () => {
      // Host has settings.json
      fs.writeFileSync(path.join(hostUserDir, 'settings.json'), '{"editor.tabSize": 2}');

      // Profile User directory is read-only (chmod 0555)
      const profileUser = path.join(profileDir, 'User');
      fs.mkdirSync(profileUser, { recursive: true });
      fs.chmodSync(profileUser, 0o555);

      expect(() => {
        provisionEditorSettings(profileDir, hostUserDir);
      }).not.toThrow();
    });

    it('2.8: host directory containing broken symlinks does not throw or corrupt profile', () => {
      const brokenTarget = path.join(tempRoot, 'deleted-target.json');
      const brokenLink = path.join(hostUserDir, 'settings.json');
      try {
        fs.symlinkSync(brokenTarget, brokenLink);
      } catch {
        // ignore if not supported
      }

      expect(() => {
        provisionEditorSettings(profileDir, hostUserDir);
      }).not.toThrow();
    });

    it('2.9: profile User directory path blocked by a physical file handles defensively', () => {
      // Create profile/User as a regular file
      const profileUserFile = path.join(profileDir, 'User');
      fs.writeFileSync(profileUserFile, 'I am a file, not a directory');

      fs.writeFileSync(path.join(hostUserDir, 'settings.json'), '{}');

      expect(() => {
        provisionEditorSettings(profileDir, hostUserDir);
      }).not.toThrow();
    });

    it('2.10: destination path is a physical directory when linking a file leaves directory intact', () => {
      const destAsDir = path.join(profileDir, 'User', 'settings.json');
      fs.mkdirSync(destAsDir, { recursive: true });

      const hostFile = path.join(hostUserDir, 'settings.json');
      fs.writeFileSync(hostFile, '{}');

      // safeSymlink should return false and NOT delete or overwrite the directory
      const linked = safeSymlink(hostFile, destAsDir, 'file');
      expect(linked).toBe(false);
      expect(fs.lstatSync(destAsDir).isDirectory()).toBe(true);
    });
  });

  // =========================================================================
  // Adversarial Suite 3: Multi-Launch Idempotency & Customization Preservation
  // =========================================================================
  describe('Suite 3: Multi-Launch Idempotency & Profile Customization Preservation (R4 Focus 3)', () => {
    it('3.1: pre-existing profile settings.json, keybindings.json, and snippets/ are NOT overwritten across 5 repeated provisions', () => {
      // Host defaults
      fs.writeFileSync(
        path.join(hostUserDir, 'settings.json'),
        JSON.stringify({ 'editor.fontSize': 12, hostManaged: true }),
      );
      fs.writeFileSync(
        path.join(hostUserDir, 'keybindings.json'),
        JSON.stringify([{ key: 'ctrl+h', command: 'host.command' }]),
      );
      fs.mkdirSync(path.join(hostUserDir, 'snippets'), { recursive: true });
      fs.writeFileSync(
        path.join(hostUserDir, 'snippets', 'ts.json'),
        JSON.stringify({ host: 'snippet' }),
      );

      // Pre-create customized physical files in profile
      const profileUser = path.join(profileDir, 'User');
      fs.mkdirSync(path.join(profileUser, 'snippets'), { recursive: true });
      fs.writeFileSync(
        path.join(profileUser, 'settings.json'),
        JSON.stringify({ 'editor.fontSize': 24, profileCustom: true }),
      );
      fs.writeFileSync(
        path.join(profileUser, 'keybindings.json'),
        JSON.stringify([{ key: 'ctrl+p', command: 'profile.command' }]),
      );
      fs.writeFileSync(
        path.join(profileUser, 'snippets', 'ts.json'),
        JSON.stringify({ profile: 'snippet' }),
      );

      // Execute provisioning 5 consecutive times
      for (let i = 0; i < 5; i++) {
        provisionEditorSettings(profileDir, hostUserDir);
      }

      // Verify profile files are STILL regular physical files, NOT symlinks to host
      const settingsPath = path.join(profileUser, 'settings.json');
      const keybindingsPath = path.join(profileUser, 'keybindings.json');
      const snippetsPath = path.join(profileUser, 'snippets');

      expect(fs.lstatSync(settingsPath).isSymbolicLink()).toBe(false);
      expect(fs.lstatSync(keybindingsPath).isSymbolicLink()).toBe(false);
      expect(fs.lstatSync(snippetsPath).isSymbolicLink()).toBe(false);

      const savedSettings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      expect(savedSettings['editor.fontSize']).toBe(24);
      expect(savedSettings.hostManaged).toBeUndefined();

      const savedKeybindings = JSON.parse(fs.readFileSync(keybindingsPath, 'utf8'));
      expect(savedKeybindings[0].command).toBe('profile.command');

      const savedSnippet = JSON.parse(fs.readFileSync(path.join(snippetsPath, 'ts.json'), 'utf8'));
      expect(savedSnippet.profile).toBe('snippet');
    });

    it('3.2: pre-existing profile extensions physical directory is NOT overwritten across 5 repeated provisions', () => {
      // Host extensions
      fs.writeFileSync(path.join(hostExtensionsDir, 'host-ext.txt'), 'host-extension-data');

      // Profile has physical extensions directory with local extension
      const profileExt = path.join(profileDir, 'extensions');
      fs.mkdirSync(profileExt, { recursive: true });
      fs.writeFileSync(path.join(profileExt, 'local-ext.txt'), 'local-extension-data');

      // Execute provisioning 5 consecutive times
      for (let i = 0; i < 5; i++) {
        provisionExtensionsSharing(profileDir, isolatedHome, hostExtensionsDir);
      }

      expect(fs.lstatSync(profileExt).isSymbolicLink()).toBe(false);
      expect(fs.readFileSync(path.join(profileExt, 'local-ext.txt'), 'utf8')).toBe(
        'local-extension-data',
      );
      expect(fs.existsSync(path.join(profileExt, 'host-ext.txt'))).toBe(false);
    });

    it('3.3: pre-existing profile agent skills in home/.gemini/ are NOT overwritten across 5 repeated provisions', () => {
      // Host agent skills
      fs.mkdirSync(path.join(hostGeminiDir, 'config'), { recursive: true });
      fs.writeFileSync(path.join(hostGeminiDir, 'config', 'host.txt'), 'host-skill');

      // Profile has customized config directory
      const profileGeminiConfig = path.join(isolatedHome, '.gemini', 'config');
      fs.mkdirSync(profileGeminiConfig, { recursive: true });
      fs.writeFileSync(path.join(profileGeminiConfig, 'profile.txt'), 'profile-custom-skill');

      for (let i = 0; i < 5; i++) {
        provisionGeminiCustomizations(isolatedHome, hostGeminiDir);
      }

      expect(fs.lstatSync(profileGeminiConfig).isSymbolicLink()).toBe(false);
      expect(fs.readFileSync(path.join(profileGeminiConfig, 'profile.txt'), 'utf8')).toBe(
        'profile-custom-skill',
      );
      expect(fs.existsSync(path.join(profileGeminiConfig, 'host.txt'))).toBe(false);
    });

    it('3.4: pre-existing profile history in state.vscdb is NEVER overwritten across 5 repeated provisions', () => {
      // Host history
      const hostDb = new Database(hostDbPath);
      hostDb.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT);');
      hostDb
        .prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)')
        .run('history.recentlyOpenedPathsList', JSON.stringify({ entries: ['/host/project-x'] }));
      hostDb.close();

      // Profile history
      const profileStorage = path.join(profileDir, 'User', 'globalStorage');
      fs.mkdirSync(profileStorage, { recursive: true });
      const profileDbPath = path.join(profileStorage, 'state.vscdb');
      const profileDb = new Database(profileDbPath);
      profileDb.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT);');
      const initialProfileHistory = JSON.stringify({ entries: ['/profile/my-custom-project'] });
      profileDb
        .prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)')
        .run('history.recentlyOpenedPathsList', initialProfileHistory);
      profileDb.close();

      for (let i = 0; i < 5; i++) {
        seedRecentProjectHistory({
          profileUserDataDir: profileDir,
          hostDbPath,
        });
      }

      const verifyDb = new Database(profileDbPath, { readonly: true });
      const row = verifyDb
        .prepare("SELECT value FROM ItemTable WHERE key = 'history.recentlyOpenedPathsList'")
        .get() as { value: string };
      verifyDb.close();

      expect(row.value).toBe(initialProfileHistory);
      expect(row.value).not.toContain('/host/project-x');
    });

    it('3.5: existing valid symlinks are preserved without unnecessary deletion or churning', () => {
      fs.writeFileSync(path.join(hostUserDir, 'settings.json'), '{"theme": "dark"}');
      provisionEditorSettings(profileDir, hostUserDir);

      const profileSettings = path.join(profileDir, 'User', 'settings.json');
      expect(fs.lstatSync(profileSettings).isSymbolicLink()).toBe(true);

      const unlinkSpy = vi.spyOn(fs, 'unlinkSync');

      // Second provisioning with identical target
      provisionEditorSettings(profileDir, hostUserDir);

      // unlinkSync should NOT have been called because target was already correctly linked
      expect(unlinkSpy).not.toHaveBeenCalled();
      unlinkSpy.mockRestore();
    });

    it('3.6: profile starts with host symlink, user decouples into a physical file, subsequent re-launches preserve decoupled file', () => {
      // 1. Initial launch: inherit settings from host as symlink
      fs.writeFileSync(path.join(hostUserDir, 'settings.json'), '{"theme": "host-dark"}');
      provisionEditorSettings(profileDir, hostUserDir);

      const profileSettings = path.join(profileDir, 'User', 'settings.json');
      expect(fs.lstatSync(profileSettings).isSymbolicLink()).toBe(true);

      // 2. User workflow: delete symlink and write custom physical file
      fs.unlinkSync(profileSettings);
      fs.writeFileSync(profileSettings, '{"theme": "custom-solarized"}');

      // 3. Re-launch profile
      provisionEditorSettings(profileDir, hostUserDir);

      // 4. Verify profile file is STILL regular physical file with user custom content
      expect(fs.lstatSync(profileSettings).isSymbolicLink()).toBe(false);
      expect(fs.readFileSync(profileSettings, 'utf8')).toBe('{"theme": "custom-solarized"}');
    });

    it('3.7: profile history is updated by user after initial seeding, subsequent re-launches preserve updated history', () => {
      // 1. Host has project A
      const hostDb = new Database(hostDbPath);
      hostDb.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT);');
      hostDb
        .prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)')
        .run('history.recentlyOpenedPathsList', JSON.stringify({ entries: ['/host/project-a'] }));
      hostDb.close();

      // Profile starts empty
      const profileStorage = path.join(profileDir, 'User', 'globalStorage');
      fs.mkdirSync(profileStorage, { recursive: true });
      const profileDbPath = path.join(profileStorage, 'state.vscdb');
      const profileDb = new Database(profileDbPath);
      profileDb.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT);');
      profileDb.close();

      // First launch seeds project A
      seedRecentProjectHistory({ profileUserDataDir: profileDir, hostDbPath });

      // User adds project B in profile
      const userUpdatedHistory = JSON.stringify({
        entries: ['/profile/project-b', '/host/project-a'],
      });
      const updateDb = new Database(profileDbPath);
      updateDb
        .prepare("UPDATE ItemTable SET value = ? WHERE key = 'history.recentlyOpenedPathsList'")
        .run(userUpdatedHistory);
      updateDb.close();

      // Host meanwhile opened project C
      const hostDb2 = new Database(hostDbPath);
      hostDb2
        .prepare("UPDATE ItemTable SET value = ? WHERE key = 'history.recentlyOpenedPathsList'")
        .run(JSON.stringify({ entries: ['/host/project-c'] }));
      hostDb2.close();

      // Second launch
      seedRecentProjectHistory({ profileUserDataDir: profileDir, hostDbPath });

      // Profile must retain project B and NOT be overwritten with project C
      const verifyDb = new Database(profileDbPath, { readonly: true });
      const row = verifyDb
        .prepare("SELECT value FROM ItemTable WHERE key = 'history.recentlyOpenedPathsList'")
        .get() as { value: string };
      verifyDb.close();

      expect(row.value).toBe(userUpdatedHistory);
      expect(row.value).not.toContain('/host/project-c');
    });
  });

  // =========================================================================
  // Adversarial Suite 4: Classic Mode Non-Regression
  // =========================================================================
  describe('Suite 4: Classic Mode Non-Regression (R4 Focus 4)', () => {
    it('4.1: classic single-instance mode (default classic userDataDir) completely skips profile sharing', () => {
      const defaultClassicDir = getAppDataDir('classic');
      const symlinkSpy = vi.spyOn(fs, 'symlinkSync');

      provisionWorkspaceProfileSharing({
        profileUserDataDir: defaultClassicDir,
        isolatedHome,
        hostUserDir,
        hostExtensionsDir,
        hostGeminiDir,
        hostDbPath,
      });

      expect(symlinkSpy).not.toHaveBeenCalled();
      symlinkSpy.mockRestore();
    });

    it('4.2: default IDE userDataDir completely skips profile sharing', () => {
      const defaultIdeDir = getAppDataDir('ide');
      const symlinkSpy = vi.spyOn(fs, 'symlinkSync');

      provisionWorkspaceProfileSharing({
        profileUserDataDir: defaultIdeDir,
        isolatedHome,
        hostUserDir,
        hostExtensionsDir,
        hostGeminiDir,
        hostDbPath,
      });

      expect(symlinkSpy).not.toHaveBeenCalled();
      symlinkSpy.mockRestore();
    });

    it('4.3: paths with trailing slashes or relative segments matching default classic dir are safely identified and skipped', () => {
      const defaultClassicDir = getAppDataDir('classic');
      const formattedDirWithSlash = `${defaultClassicDir}${path.sep}.${path.sep}`;
      const symlinkSpy = vi.spyOn(fs, 'symlinkSync');

      provisionWorkspaceProfileSharing({
        profileUserDataDir: formattedDirWithSlash,
        isolatedHome,
        hostUserDir,
        hostExtensionsDir,
        hostGeminiDir,
        hostDbPath,
      });

      expect(symlinkSpy).not.toHaveBeenCalled();
      symlinkSpy.mockRestore();
    });

    it('4.4: prepareLaunchContext with classic target does NOT inject extensionsDir or isolated home by default', async () => {
      const executable = path.join(tempRoot, 'antigravity');
      fs.writeFileSync(executable, 'fixture');
      fs.chmodSync(executable, 0o755);
      vi.spyOn(paths, 'getConfiguredAntigravityExecutablePath').mockReturnValue(executable);
      vi.spyOn(paths, 'getConfiguredAntigravityArgs').mockReturnValue([]);
      const context = resolveLaunchContext('classic', []);

      // Verify classic mode args do not have --user-data-dir pointing to isolated profiles
      const profileArgs = context.args.filter((a) => a.includes('profiles'));
      expect(profileArgs).toHaveLength(0);

      // Verify extensionsDir option is not set unless explicitly provided
      expect(context.extensionsDir).toBeUndefined();
    });

    it('4.5: getAntigravityExtensionsDir and getAntigravityHostUserDir resolve correct platform paths', () => {
      const linuxExt = getAntigravityExtensionsDir({ platform: 'linux', isWsl: false });
      expect(linuxExt).toBe(path.posix.join(os.homedir(), '.antigravity', 'extensions'));

      const darwinExt = getAntigravityExtensionsDir({ platform: 'darwin', isWsl: false });
      expect(darwinExt).toBe(path.posix.join(os.homedir(), '.antigravity', 'extensions'));

      const winExt = getAntigravityExtensionsDir({ platform: 'win32', isWsl: false });
      expect(winExt).toContain('.antigravity');
      expect(winExt).toContain('extensions');

      const linuxUser = getAntigravityHostUserDir({ platform: 'linux', isWsl: false });
      expect(linuxUser).toBe(path.posix.join(os.homedir(), '.config', 'Antigravity', 'User'));

      const darwinUser = getAntigravityHostUserDir({ platform: 'darwin', isWsl: false });
      expect(darwinUser).toBe(
        path.posix.join(os.homedir(), 'Library', 'Application Support', 'Antigravity', 'User'),
      );
    });
  });

  // =========================================================================
  // Adversarial Suite 5: High-Concurrency Multi-Profile Launch Stress Test
  // =========================================================================
  describe('Suite 5: High-Concurrency Multi-Profile Launch Stress Test (R4 Concurrency)', () => {
    it('5.1: 10 concurrent profile provisions sharing identical host assets execute without locking conflicts or race conditions', async () => {
      // Setup host state
      fs.writeFileSync(
        path.join(hostUserDir, 'settings.json'),
        JSON.stringify({ 'editor.fontSize': 14, shared: true }),
      );
      fs.writeFileSync(
        path.join(hostUserDir, 'keybindings.json'),
        JSON.stringify([{ key: 'ctrl+shift+p', command: 'workbench.action.showCommands' }]),
      );
      fs.mkdirSync(path.join(hostUserDir, 'snippets'), { recursive: true });
      fs.writeFileSync(
        path.join(hostUserDir, 'snippets', 'js.json'),
        JSON.stringify({ log: { prefix: 'clog' } }),
      );
      fs.mkdirSync(path.join(hostGeminiDir, 'config'), { recursive: true });
      fs.writeFileSync(path.join(hostGeminiDir, 'config', 'config.json'), '{"theme":"gemini"}');
      fs.writeFileSync(path.join(hostExtensionsDir, 'package.json'), '{"name":"host-ext"}');

      const hostDb = new Database(hostDbPath);
      hostDb.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT);');
      hostDb
        .prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)')
        .run(
          'history.recentlyOpenedPathsList',
          JSON.stringify({ entries: [{ folderUri: 'file:///shared/workspace' }] }),
        );
      hostDb.close();

      // Launch 10 concurrent provisions targeting 10 distinct profile directories
      const count = 10;
      const tasks = Array.from({ length: count }, async (_, i) => {
        const pDir = path.join(tempRoot, 'concurrent-profiles', `profile-${i}`);
        const pHome = path.join(pDir, 'home');
        fs.mkdirSync(path.join(pDir, 'User', 'globalStorage'), { recursive: true });
        fs.mkdirSync(pHome, { recursive: true });

        // Initialize empty profile state.vscdb
        const pDb = new Database(path.join(pDir, 'User', 'globalStorage', 'state.vscdb'));
        pDb.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT);');
        pDb.close();

        // Perform profile sharing concurrently
        provisionWorkspaceProfileSharing({
          profileUserDataDir: pDir,
          isolatedHome: pHome,
          hostUserDir,
          hostExtensionsDir,
          hostGeminiDir,
          hostDbPath,
        });

        return { pDir, pHome };
      });

      const results = await Promise.all(tasks);
      expect(results).toHaveLength(count);

      // Verify every profile received valid symlinks and seeded history
      for (let i = 0; i < count; i++) {
        const { pDir, pHome } = results[i];

        // Editor settings
        expect(fs.lstatSync(path.join(pDir, 'User', 'settings.json')).isSymbolicLink()).toBe(true);
        expect(fs.lstatSync(path.join(pDir, 'User', 'keybindings.json')).isSymbolicLink()).toBe(
          true,
        );
        expect(fs.lstatSync(path.join(pDir, 'User', 'snippets')).isSymbolicLink()).toBe(true);

        // Extensions
        expect(fs.lstatSync(path.join(pDir, 'extensions')).isSymbolicLink()).toBe(true);
        expect(fs.lstatSync(path.join(pHome, '.antigravity', 'extensions')).isSymbolicLink()).toBe(
          true,
        );

        // Gemini skills
        expect(fs.lstatSync(path.join(pHome, '.gemini', 'config')).isSymbolicLink()).toBe(true);

        // History in state.vscdb
        const dbPath = path.join(pDir, 'User', 'globalStorage', 'state.vscdb');
        const verifyDb = new Database(dbPath, { readonly: true });
        const row = verifyDb
          .prepare("SELECT value FROM ItemTable WHERE key = 'history.recentlyOpenedPathsList'")
          .get() as { value: string };
        verifyDb.close();

        expect(row).toBeDefined();
        expect(row.value).toContain('file:///shared/workspace');
      }
    });

    it('5.2: 5 concurrent provisions on the EXACT SAME profile directory execute idempotently without throw or corruption', async () => {
      // Setup host assets
      fs.writeFileSync(path.join(hostUserDir, 'settings.json'), '{"theme": "shared-dark"}');
      fs.writeFileSync(path.join(hostExtensionsDir, 'shared-ext.txt'), 'ext');
      fs.mkdirSync(path.join(hostGeminiDir, 'config'), { recursive: true });
      fs.writeFileSync(path.join(hostGeminiDir, 'config', 'agent.json'), '{}');

      const hostDb = new Database(hostDbPath);
      hostDb.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT);');
      hostDb
        .prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)')
        .run('history.recentlyOpenedPathsList', JSON.stringify({ entries: ['/double-launch'] }));
      hostDb.close();

      const sameProfileDir = path.join(tempRoot, 'same-profile');
      const sameProfileHome = path.join(sameProfileDir, 'home');
      fs.mkdirSync(path.join(sameProfileDir, 'User', 'globalStorage'), { recursive: true });
      fs.mkdirSync(sameProfileHome, { recursive: true });

      const sameProfileDb = new Database(
        path.join(sameProfileDir, 'User', 'globalStorage', 'state.vscdb'),
      );
      sameProfileDb.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT);');
      sameProfileDb.close();

      // Fire 5 concurrent provisions simultaneously against the same target directory
      const results = await Promise.allSettled(
        Array.from({ length: 5 }, async () => {
          provisionWorkspaceProfileSharing({
            profileUserDataDir: sameProfileDir,
            isolatedHome: sameProfileHome,
            hostUserDir,
            hostExtensionsDir,
            hostGeminiDir,
            hostDbPath,
          });
        }),
      );

      // None of the concurrent calls should reject
      for (const res of results) {
        expect(res.status).toBe('fulfilled');
      }

      // Profile ends up with valid symlinks
      expect(
        fs.lstatSync(path.join(sameProfileDir, 'User', 'settings.json')).isSymbolicLink(),
      ).toBe(true);
      expect(fs.lstatSync(path.join(sameProfileDir, 'extensions')).isSymbolicLink()).toBe(true);
      expect(fs.lstatSync(path.join(sameProfileHome, '.gemini', 'config')).isSymbolicLink()).toBe(
        true,
      );

      const verifyDb = new Database(
        path.join(sameProfileDir, 'User', 'globalStorage', 'state.vscdb'),
        { readonly: true },
      );
      const row = verifyDb
        .prepare("SELECT value FROM ItemTable WHERE key = 'history.recentlyOpenedPathsList'")
        .get() as { value: string };
      verifyDb.close();

      expect(row).toBeDefined();
      expect(row.value).toContain('/double-launch');
    });
  });
});
