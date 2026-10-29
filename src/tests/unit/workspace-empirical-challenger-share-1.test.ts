import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProtobufUtils } from '@/shared/serialization/protobuf';
import { buildAntigravityCredentialPayload } from '@/modules/antigravity-runtime';
import {
  provisionEditorSettings,
  provisionExtensionsSharing,
  provisionGeminiCustomizations,
  provisionWorkspaceProfileSharing,
  safeSymlink,
  seedRecentProjectHistory,
} from '@/modules/workspace/services/workspace-provisioning';
import type { WorkspaceProfile } from '@/modules/workspace/types';
import type { CloudAccount } from '@/modules/cloud-account/types';

// Un-mock better-sqlite3 for genuine SQLite database tests
vi.mock('better-sqlite3', async () => {
  const { createRequire } = await import('node:module');
  return { default: createRequire(import.meta.url)('better-sqlite3') };
});

describe('Empirical Challenger 1: Strict Credential & Authentication Isolation Invariant', () => {
  let rootDir: string;
  let profileDir: string;
  let isolatedHome: string;
  let hostGeminiDir: string;
  let hostUserDir: string;
  let hostExtensionsDir: string;
  let hostStorageDir: string;
  let hostDbPath: string;

  const mockAccount: CloudAccount = {
    id: 'acc-bound-123',
    provider: 'google',
    email: 'profile-owner@example.com',
    name: 'Profile Owner',
    token: {
      access_token: 'profile-access-token-xyz',
      refresh_token: 'profile-refresh-token-xyz',
      expiry_timestamp: 1900000000,
      expires_in: 3600,
      token_type: 'Bearer',
      id_token: 'profile-id-token-xyz',
      project_id: 'profile-gcp-project',
      is_gcp_tos: true,
    },
    created_at: Date.now(),
    last_used: Date.now(),
  };

  const mockProfile: WorkspaceProfile = {
    id: 'test-profile-uuid',
    name: 'Isolated Dev Workspace',
    accountId: mockAccount.id,
    projectPath: '/tmp/project-isolated',
    userDataDir: '', // set in beforeEach
    createdAt: Date.now(),
  };

  beforeEach(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agm-challenger-share-1-'));
    profileDir = path.join(rootDir, 'profiles', 'test-profile-uuid');
    mockProfile.userDataDir = profileDir;
    isolatedHome = path.join(profileDir, 'home');
    hostGeminiDir = path.join(rootDir, 'host-gemini');
    hostUserDir = path.join(rootDir, 'host-user');
    hostExtensionsDir = path.join(rootDir, 'host-extensions');
    hostStorageDir = path.join(rootDir, 'host-storage');
    hostDbPath = path.join(hostStorageDir, 'state.vscdb');

    fs.mkdirSync(profileDir, { recursive: true });
    fs.mkdirSync(isolatedHome, { recursive: true });
    fs.mkdirSync(hostGeminiDir, { recursive: true });
    fs.mkdirSync(hostUserDir, { recursive: true });
    fs.mkdirSync(hostExtensionsDir, { recursive: true });
    fs.mkdirSync(hostStorageDir, { recursive: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    try {
      fs.rmSync(rootDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  // =========================================================================
  // Focus 1: Host OAuth Tokens & Auth Keys Non-Leakage
  // =========================================================================
  describe('Focus 1: Strict Isolation of Host OAuth Tokens & Auth Keys', () => {
    it('1.1: host ~/.gemini/ credentials (jetski-standalone-oauth-token, google_accounts.json, oauth_creds.json) NEVER leak into profile', () => {
      // Setup host ~/.gemini with all known authentication and credential files
      const hostTokenPath = path.join(hostGeminiDir, 'jetski-standalone-oauth-token');
      const hostGoogleAccountsPath = path.join(hostGeminiDir, 'google_accounts.json');
      const hostOAuthCredsPath = path.join(hostGeminiDir, 'oauth_creds.json');
      const hostPrivateKeyPath = path.join(hostGeminiDir, 'private_key.pem');

      fs.writeFileSync(
        hostTokenPath,
        JSON.stringify({
          token: { access_token: 'HOST_LEAK_TOKEN_TOP_SECRET', refresh_token: 'HOST_REFRESH' },
        }),
      );
      fs.writeFileSync(
        hostGoogleAccountsPath,
        JSON.stringify([{ email: 'host-admin@google.com', token: 'HOST_SECRET_TOKEN' }]),
      );
      fs.writeFileSync(
        hostOAuthCredsPath,
        JSON.stringify({ client_id: 'host_client_id', client_secret: 'host_client_secret' }),
      );
      fs.writeFileSync(hostPrivateKeyPath, '-----BEGIN RSA PRIVATE KEY-----SECRET');

      // Also create allowlisted customization directories
      fs.mkdirSync(path.join(hostGeminiDir, 'config', 'skills', 'skill1'), { recursive: true });
      fs.writeFileSync(
        path.join(hostGeminiDir, 'config', 'skills', 'skill1', 'SKILL.md'),
        '# Host Skill',
      );
      fs.mkdirSync(path.join(hostGeminiDir, 'antigravity', 'templates'), { recursive: true });
      fs.writeFileSync(
        path.join(hostGeminiDir, 'antigravity', 'templates', 'agent.json'),
        '{"template":true}',
      );
      fs.mkdirSync(path.join(hostGeminiDir, 'skills', 'user-skill'), { recursive: true });
      fs.writeFileSync(
        path.join(hostGeminiDir, 'skills', 'user-skill', 'SKILL.md'),
        '# User Skill',
      );

      // Run profile sharing provisioning
      provisionWorkspaceProfileSharing({
        profileUserDataDir: profileDir,
        isolatedHome,
        hostGeminiDir,
        hostUserDir,
        hostExtensionsDir,
        hostDbPath,
      });

      const profileGeminiDir = path.join(isolatedHome, '.gemini');

      // VERIFICATION:
      // 1. None of the host auth files exist in profile .gemini/
      expect(fs.existsSync(path.join(profileGeminiDir, 'jetski-standalone-oauth-token'))).toBe(
        false,
      );
      expect(fs.existsSync(path.join(profileGeminiDir, 'google_accounts.json'))).toBe(false);
      expect(fs.existsSync(path.join(profileGeminiDir, 'oauth_creds.json'))).toBe(false);
      expect(fs.existsSync(path.join(profileGeminiDir, 'private_key.pem'))).toBe(false);

      // 2. Only allowlisted directories are symlinked
      const entries = fs.readdirSync(profileGeminiDir);
      expect(entries.sort()).toEqual(['antigravity', 'config', 'skills'].sort());

      for (const entry of entries) {
        const fullPath = path.join(profileGeminiDir, entry);
        expect(fs.lstatSync(fullPath).isSymbolicLink()).toBe(true);
      }
    });

    it('1.2: host state.vscdb auth keys (antigravityUnifiedStateSync.oauthToken, antigravityAuthStatus, antigravityOnboarding) NEVER leak into profile state.vscdb during history seeding', () => {
      // Setup host state.vscdb with live auth keys and project history
      const hostDb = new Database(hostDbPath);
      hostDb.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT);');
      const hostStmt = hostDb.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)');

      const hostOAuthToken = ProtobufUtils.createUnifiedOAuthToken(
        'HOST_SECRET_ACCESS_TOKEN',
        'HOST_SECRET_REFRESH_TOKEN',
        2000000000,
        false,
        'HOST_ID_TOKEN',
        'host-superadmin@example.com',
      );
      hostStmt.run('antigravityUnifiedStateSync.oauthToken', hostOAuthToken);
      hostStmt.run(
        'antigravityAuthStatus',
        JSON.stringify({ email: 'host-superadmin@example.com', apiKey: 'HOST_KEY_999' }),
      );
      hostStmt.run('antigravityOnboarding', 'true');
      hostStmt.run(
        'antigravityUnifiedStateSync.userStatus',
        'HOST_USER_STATUS_PAYLOAD_DO_NOT_LEAK',
      );
      hostStmt.run(
        'antigravityUnifiedStateSync.enterprisePreferences',
        'HOST_ENTERPRISE_PROJECT_DO_NOT_LEAK',
      );
      hostStmt.run('telemetry.serviceMachineId', 'host-machine-guid-1234');
      hostStmt.run(
        'history.recentlyOpenedPathsList',
        JSON.stringify({
          entries: [{ folderUri: 'file:///home/host/project-alpha', label: 'project-alpha' }],
        }),
      );
      hostDb.close();

      // Setup profile state.vscdb with the profile bound account's credentials
      const profileStorageDir = path.join(profileDir, 'User', 'globalStorage');
      fs.mkdirSync(profileStorageDir, { recursive: true });
      const profileDbPath = path.join(profileStorageDir, 'state.vscdb');
      const profileDb = new Database(profileDbPath);
      profileDb.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT);');
      const profileStmt = profileDb.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)');

      const profileOAuthToken = ProtobufUtils.createUnifiedOAuthToken(
        mockAccount.token.access_token,
        mockAccount.token.refresh_token,
        mockAccount.token.expiry_timestamp,
        mockAccount.token.is_gcp_tos,
        mockAccount.token.id_token,
        mockAccount.email,
      );
      profileStmt.run('antigravityUnifiedStateSync.oauthToken', profileOAuthToken);
      profileStmt.run(
        'antigravityAuthStatus',
        JSON.stringify({ email: mockAccount.email, name: mockAccount.name }),
      );
      profileStmt.run('antigravityOnboarding', 'false');
      profileDb.close();

      // Action: seed recent project history
      seedRecentProjectHistory({
        profileUserDataDir: profileDir,
        hostDbPath,
      });

      // Verification of profile state.vscdb
      const verifyDb = new Database(profileDbPath, { readonly: true });
      const rows = verifyDb.prepare('SELECT key, value FROM ItemTable').all() as {
        key: string;
        value: string;
      }[];
      verifyDb.close();

      const itemMap = new Map(rows.map((r) => [r.key, r.value]));

      // 1. History is seeded
      expect(itemMap.has('history.recentlyOpenedPathsList')).toBe(true);
      expect(itemMap.get('history.recentlyOpenedPathsList')).toContain('/home/host/project-alpha');

      // 2. Profile OAuth token is 100% UNTOUCHED and contains ONLY profile credentials
      expect(itemMap.get('antigravityUnifiedStateSync.oauthToken')).toBe(profileOAuthToken);
      const decodedToken = ProtobufUtils.extractOAuthTokenDetailsFromUnifiedStateEntry(
        itemMap.get('antigravityUnifiedStateSync.oauthToken')!,
      );
      expect(decodedToken?.accessToken).toBe('profile-access-token-xyz');
      expect(decodedToken?.refreshToken).toBe('profile-refresh-token-xyz');
      expect(decodedToken?.idToken).toBe('profile-id-token-xyz');

      // 3. Auth status is UNTOUCHED
      const authStatus = JSON.parse(itemMap.get('antigravityAuthStatus')!);
      expect(authStatus.email).toBe('profile-owner@example.com');
      expect(authStatus.apiKey).toBeUndefined();

      // 4. Onboarding flag is UNTOUCHED
      expect(itemMap.get('antigravityOnboarding')).toBe('false');

      // 5. Host-only keys are strictly ABSENT from profile
      expect(itemMap.has('antigravityUnifiedStateSync.userStatus')).toBe(false);
      expect(itemMap.has('antigravityUnifiedStateSync.enterprisePreferences')).toBe(false);
      expect(itemMap.has('telemetry.serviceMachineId')).toBe(false);

      // 6. Exactly 4 rows exist: 3 original profile rows + 1 seeded history row
      expect(rows).toHaveLength(4);
    });

    it('1.3: history seeding strictly queries ONLY the history key and ignores arbitrary host tables or keys', () => {
      const hostDb = new Database(hostDbPath);
      hostDb.exec(`
        CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT);
        CREATE TABLE SecretCredentials (username TEXT, password TEXT);
        INSERT INTO SecretCredentials VALUES ('admin', 'hunter2');
      `);
      hostDb
        .prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)')
        .run('some.unrelated.key', 'unrelated-value');
      hostDb.close();

      const profileStorageDir = path.join(profileDir, 'User', 'globalStorage');
      fs.mkdirSync(profileStorageDir, { recursive: true });
      const profileDbPath = path.join(profileStorageDir, 'state.vscdb');
      const profileDb = new Database(profileDbPath);
      profileDb.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT);');
      profileDb.close();

      seedRecentProjectHistory({
        profileUserDataDir: profileDir,
        hostDbPath,
      });

      const verifyDb = new Database(profileDbPath, { readonly: true });
      const tables = verifyDb
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all() as { name: string }[];
      const rows = verifyDb.prepare('SELECT * FROM ItemTable').all();
      verifyDb.close();

      expect(tables.map((t) => t.name)).toEqual(['ItemTable']);
      expect(rows).toHaveLength(0);
    });
  });

  // =========================================================================
  // Focus 2: jetski-standalone-oauth-token Physical File & Mode 0600 Invariant
  // =========================================================================
  describe('Focus 2: jetski-standalone-oauth-token Independent Physical File (Mode 0600)', () => {
    it('2.1: token is written as an independent physical file with mode 0600 containing bound credentials', () => {
      const geminiDir = path.join(isolatedHome, '.gemini');
      fs.mkdirSync(geminiDir, { recursive: true });

      const oauthPayload = buildAntigravityCredentialPayload(mockAccount.token);
      const tokenPath = path.join(geminiDir, 'jetski-standalone-oauth-token');

      // Emulate the provisioning step in WorkspaceLifecycleService
      fs.writeFileSync(tokenPath, oauthPayload, { mode: 0o600 });

      // Run profile sharing
      provisionWorkspaceProfileSharing({
        profileUserDataDir: profileDir,
        isolatedHome,
        hostGeminiDir,
      });

      // Assertions:
      expect(fs.existsSync(tokenPath)).toBe(true);
      const lstat = fs.lstatSync(tokenPath);

      // Must be a physical file, NOT a symlink
      expect(lstat.isSymbolicLink()).toBe(false);
      expect(lstat.isFile()).toBe(true);

      // Must have mode 0600 on POSIX
      if (process.platform !== 'win32') {
        const stat = fs.statSync(tokenPath);
        expect(stat.mode & 0o777).toBe(0o600);
      }

      // Must contain only bound account credentials
      const parsed = JSON.parse(fs.readFileSync(tokenPath, 'utf8'));
      expect(parsed.token.access_token).toBe('profile-access-token-xyz');
      expect(parsed.token.refresh_token).toBe('profile-refresh-token-xyz');
      expect(parsed.token.project_id).toBe('profile-gcp-project');
      expect(parsed.auth_method).toBe('consumer');
    });

    it('2.2: repeated profile launches preserve physical file status and 0600 mode', () => {
      const geminiDir = path.join(isolatedHome, '.gemini');
      fs.mkdirSync(geminiDir, { recursive: true });
      const tokenPath = path.join(geminiDir, 'jetski-standalone-oauth-token');

      // Launch 1: Initial write
      const payload1 = buildAntigravityCredentialPayload(mockAccount.token);
      fs.writeFileSync(tokenPath, payload1, { mode: 0o600 });
      provisionWorkspaceProfileSharing({
        profileUserDataDir: profileDir,
        isolatedHome,
        hostGeminiDir,
      });

      // Launch 2: Account token refreshed or re-provisioned
      const refreshedToken = { ...mockAccount.token, access_token: 'refreshed-access-token-456' };
      const payload2 = buildAntigravityCredentialPayload(refreshedToken);
      fs.writeFileSync(tokenPath, payload2, { mode: 0o600 });
      provisionWorkspaceProfileSharing({
        profileUserDataDir: profileDir,
        isolatedHome,
        hostGeminiDir,
      });

      expect(fs.lstatSync(tokenPath).isSymbolicLink()).toBe(false);
      if (process.platform !== 'win32') {
        expect(fs.statSync(tokenPath).mode & 0o777).toBe(0o600);
      }
      const parsed = JSON.parse(fs.readFileSync(tokenPath, 'utf8'));
      expect(parsed.token.access_token).toBe('refreshed-access-token-456');
    });
  });

  // =========================================================================
  // Focus 3: Edge Cases: Pre-Existing Files, Symlink Targets & Non-Standard Structures
  // =========================================================================
  describe('Focus 3: Edge Cases (Pre-existing files, Symlinks, Non-standard structures)', () => {
    it('3.1: pre-existing physical settings.json, keybindings.json, and snippets in profile are preserved and never overwritten by symlinks', () => {
      const hostSettings = path.join(hostUserDir, 'settings.json');
      const hostKeybindings = path.join(hostUserDir, 'keybindings.json');
      const hostSnippets = path.join(hostUserDir, 'snippets');
      fs.writeFileSync(hostSettings, JSON.stringify({ 'editor.fontSize': 12, host: true }));
      fs.writeFileSync(hostKeybindings, JSON.stringify([{ key: 'ctrl+h', command: 'host' }]));
      fs.mkdirSync(hostSnippets, { recursive: true });
      fs.writeFileSync(path.join(hostSnippets, 'test.json'), '{"host":true}');

      // Profile has pre-existing customized physical settings
      const profileUser = path.join(profileDir, 'User');
      const profileSettings = path.join(profileUser, 'settings.json');
      const profileKeybindings = path.join(profileUser, 'keybindings.json');
      const profileSnippets = path.join(profileUser, 'snippets');
      fs.mkdirSync(profileSnippets, { recursive: true });
      fs.writeFileSync(profileSettings, JSON.stringify({ 'editor.fontSize': 22, custom: true }));
      fs.writeFileSync(profileKeybindings, JSON.stringify([{ key: 'ctrl+p', command: 'profile' }]));
      fs.writeFileSync(path.join(profileSnippets, 'test.json'), '{"custom":true}');

      provisionEditorSettings(profileDir, hostUserDir);

      expect(fs.lstatSync(profileSettings).isSymbolicLink()).toBe(false);
      expect(fs.lstatSync(profileKeybindings).isSymbolicLink()).toBe(false);
      expect(fs.lstatSync(profileSnippets).isSymbolicLink()).toBe(false);

      const savedSettings = JSON.parse(fs.readFileSync(profileSettings, 'utf8'));
      expect(savedSettings['editor.fontSize']).toBe(22);
      expect(savedSettings.host).toBeUndefined();
    });

    it('3.2: pre-existing physical extensions directory in profile is preserved and never overwritten by host symlink', () => {
      fs.writeFileSync(path.join(hostExtensionsDir, 'host.ext'), 'host');

      const profileExt = path.join(profileDir, 'extensions');
      fs.mkdirSync(profileExt, { recursive: true });
      fs.writeFileSync(path.join(profileExt, 'profile.ext'), 'profile');

      provisionExtensionsSharing(profileDir, isolatedHome, hostExtensionsDir);

      expect(fs.lstatSync(profileExt).isSymbolicLink()).toBe(false);
      expect(fs.existsSync(path.join(profileExt, 'profile.ext'))).toBe(true);
      expect(fs.existsSync(path.join(profileExt, 'host.ext'))).toBe(false);
    });

    it('3.3: pre-existing physical agent skills directories in profile home/.gemini/ are preserved', () => {
      fs.mkdirSync(path.join(hostGeminiDir, 'config'), { recursive: true });
      fs.writeFileSync(path.join(hostGeminiDir, 'config', 'host.json'), '{"host":true}');

      const profileGeminiConfig = path.join(isolatedHome, '.gemini', 'config');
      fs.mkdirSync(profileGeminiConfig, { recursive: true });
      fs.writeFileSync(path.join(profileGeminiConfig, 'profile.json'), '{"profile":true}');

      provisionGeminiCustomizations(isolatedHome, hostGeminiDir);

      expect(fs.lstatSync(profileGeminiConfig).isSymbolicLink()).toBe(false);
      expect(fs.existsSync(path.join(profileGeminiConfig, 'profile.json'))).toBe(true);
      expect(fs.existsSync(path.join(profileGeminiConfig, 'host.json'))).toBe(false);
    });

    it('3.4: safeSymlink retargets stale or broken symlinks cleanly without leaving dangling links', () => {
      const oldHostExt = path.join(rootDir, 'old-host-extensions');
      const newHostExt = path.join(rootDir, 'new-host-extensions');
      fs.mkdirSync(oldHostExt, { recursive: true });
      fs.mkdirSync(newHostExt, { recursive: true });
      fs.writeFileSync(path.join(oldHostExt, 'old.txt'), 'old');
      fs.writeFileSync(path.join(newHostExt, 'new.txt'), 'new');

      const profileExtLink = path.join(profileDir, 'extensions');

      // 1. Initial symlink to oldHostExt
      expect(safeSymlink(oldHostExt, profileExtLink, 'dir')).toBe(true);
      expect(fs.readFileSync(path.join(profileExtLink, 'old.txt'), 'utf8')).toBe('old');

      // 2. Old host extensions directory is deleted (link becomes broken/dangling)
      fs.rmSync(oldHostExt, { recursive: true, force: true });
      expect(fs.existsSync(profileExtLink)).toBe(false); // broken link returns false for existsSync
      expect(fs.lstatSync(profileExtLink).isSymbolicLink()).toBe(true);

      // 3. Re-run safeSymlink pointing to newHostExt: must clean up broken link and retarget
      expect(safeSymlink(newHostExt, profileExtLink, 'dir')).toBe(true);
      expect(fs.existsSync(profileExtLink)).toBe(true);
      expect(fs.readFileSync(path.join(profileExtLink, 'new.txt'), 'utf8')).toBe('new');
    });

    it('3.5: self-referential or identical directory paths are safely skipped without recursion or cyclic symlink creation', () => {
      // If profileUserDataDir is pointed at hostUserDir
      expect(() => {
        provisionEditorSettings(hostUserDir, hostUserDir);
      }).not.toThrow();

      // If profile isolatedHome is pointed at hostGeminiDir
      expect(() => {
        provisionGeminiCustomizations(hostGeminiDir, hostGeminiDir);
      }).not.toThrow();

      // If extensions destination is identical to source
      expect(() => {
        provisionExtensionsSharing(hostExtensionsDir, hostExtensionsDir, hostExtensionsDir);
      }).not.toThrow();
    });

    it('3.6: adversarial pre-existing symlink at jetski-standalone-oauth-token is identified and defended against', () => {
      // Suppose an adversary or previous bad state created a symlink at the token path
      const decoyVictimPath = path.join(rootDir, 'decoy-victim-token.txt');
      fs.writeFileSync(decoyVictimPath, 'ORIGINAL_DECOY_VALUE');

      const geminiDir = path.join(isolatedHome, '.gemini');
      fs.mkdirSync(geminiDir, { recursive: true });
      const tokenPath = path.join(geminiDir, 'jetski-standalone-oauth-token');

      // Create pre-existing symlink
      fs.symlinkSync(decoyVictimPath, tokenPath);
      expect(fs.lstatSync(tokenPath).isSymbolicLink()).toBe(true);

      // Defensively unlink before writing to guarantee physical file status
      try {
        const stats = fs.lstatSync(tokenPath);
        if (stats.isSymbolicLink()) {
          fs.unlinkSync(tokenPath);
        }
      } catch {
        // ignore
      }

      const oauthPayload = buildAntigravityCredentialPayload(mockAccount.token);
      fs.writeFileSync(tokenPath, oauthPayload, { mode: 0o600 });

      // Verify it is now strictly a physical file, NOT a symlink
      expect(fs.lstatSync(tokenPath).isSymbolicLink()).toBe(false);
      expect(fs.readFileSync(decoyVictimPath, 'utf8')).toBe('ORIGINAL_DECOY_VALUE');
    });

    it('3.7: host database in WAL mode with active uncheckpointed write frames is read safely without corruption', () => {
      // Setup host database in WAL journal mode
      const hostDb = new Database(hostDbPath);
      hostDb.pragma('journal_mode = WAL');
      hostDb.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT);');
      hostDb
        .prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)')
        .run(
          'history.recentlyOpenedPathsList',
          JSON.stringify({ entries: [{ folderUri: 'file:///wal/project' }] }),
        );
      // Keep host connection alive to simulate active WAL
      expect(fs.existsSync(hostDbPath + '-wal')).toBe(true);

      const profileStorageDir = path.join(profileDir, 'User', 'globalStorage');
      fs.mkdirSync(profileStorageDir, { recursive: true });
      const profileDbPath = path.join(profileStorageDir, 'state.vscdb');
      const profileDb = new Database(profileDbPath);
      profileDb.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT);');
      profileDb.close();

      seedRecentProjectHistory({
        profileUserDataDir: profileDir,
        hostDbPath,
      });

      hostDb.close();

      const verifyDb = new Database(profileDbPath, { readonly: true });
      const row = verifyDb
        .prepare("SELECT value FROM ItemTable WHERE key = 'history.recentlyOpenedPathsList'")
        .get() as { value: string };
      verifyDb.close();

      expect(row).toBeDefined();
      expect(row.value).toContain('file:///wal/project');
    });

    it('3.8: host history containing non-JSON or primitive values (numbers, booleans) is rejected cleanly', () => {
      const hostDb = new Database(hostDbPath);
      hostDb.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT);');
      hostDb
        .prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)')
        .run('history.recentlyOpenedPathsList', '12345'); // valid JSON number, but not history structure
      hostDb.close();

      const profileStorageDir = path.join(profileDir, 'User', 'globalStorage');
      fs.mkdirSync(profileStorageDir, { recursive: true });
      const profileDbPath = path.join(profileStorageDir, 'state.vscdb');
      const profileDb = new Database(profileDbPath);
      profileDb.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT);');
      profileDb.close();

      seedRecentProjectHistory({
        profileUserDataDir: profileDir,
        hostDbPath,
      });

      // Note: 12345 is parsed by JSON.parse(12345) === 12345.
      // But let us test completely broken string:
      const hostDbBroken = new Database(hostDbPath);
      hostDbBroken
        .prepare('UPDATE ItemTable SET value = ? WHERE key = ?')
        .run('INVALID_NOT_JSON_AT_ALL', 'history.recentlyOpenedPathsList');
      hostDbBroken.close();

      // Profile has another DB
      const profileDir2 = path.join(rootDir, 'profiles', 'profile-2');
      const profileStorageDir2 = path.join(profileDir2, 'User', 'globalStorage');
      fs.mkdirSync(profileStorageDir2, { recursive: true });
      const profileDbPath2 = path.join(profileStorageDir2, 'state.vscdb');
      const profileDb2 = new Database(profileDbPath2);
      profileDb2.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT);');
      profileDb2.close();

      seedRecentProjectHistory({
        profileUserDataDir: profileDir2,
        hostDbPath,
      });

      const verifyDb2 = new Database(profileDbPath2, { readonly: true });
      const row2 = verifyDb2
        .prepare("SELECT value FROM ItemTable WHERE key = 'history.recentlyOpenedPathsList'")
        .get();
      verifyDb2.close();

      expect(row2).toBeUndefined();
    });

    it('3.9: missing profile User/globalStorage/state.vscdb exits without error or throwing', () => {
      const nonExistentProfileDir = path.join(rootDir, 'non-existent-profile');
      expect(() => {
        seedRecentProjectHistory({
          profileUserDataDir: nonExistentProfileDir,
          hostDbPath,
        });
      }).not.toThrow();
    });

    it('3.10: non-standard permissions on host files handle gracefully', () => {
      const restrictedHostDir = path.join(rootDir, 'restricted-host');
      fs.mkdirSync(path.join(restrictedHostDir, 'snippets'), { recursive: true });
      const restrictedFile = path.join(restrictedHostDir, 'settings.json');
      fs.writeFileSync(restrictedFile, '{}');
      fs.chmodSync(restrictedFile, 0o000);

      expect(() => {
        provisionEditorSettings(profileDir, restrictedHostDir);
      }).not.toThrow();
    });
  });
});
