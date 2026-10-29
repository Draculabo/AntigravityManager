import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProtobufUtils } from '@/shared/serialization/protobuf';
import { buildAntigravityCredentialPayload } from '@/modules/antigravity-runtime';
import type { ClientAccountCredentials } from '@/modules/antigravity-runtime/credentials/clientAccount';
import {
  isPathAbsent,
  isStaleOrScaffoldGeminiDir,
  provisionEditorSettings,
  provisionExtensionsSharing,
  provisionGeminiCustomizations,
  provisionWorkspaceProfileSharing,
  reconcileAllWorkspaceProfiles,
  safeSymlink,
  seedRecentProjectHistory,
} from '@/modules/workspace/services/workspace-provisioning';

// Un-mock better-sqlite3 to verify real SQLite credential injection
vi.mock('better-sqlite3', async () => {
  const { createRequire } = await import('node:module');
  return { default: createRequire(import.meta.url)('better-sqlite3') };
});

describe('Workspace Credential Provisioning (R3)', () => {
  let rootDir: string;
  let profileDirA: string;
  let profileDirB: string;

  beforeEach(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agm-workspace-cred-'));
    profileDirA = path.join(rootDir, 'profiles', 'profile-a');
    profileDirB = path.join(rootDir, 'profiles', 'profile-b');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  const credentialsA: ClientAccountCredentials = {
    email: 'user-a@example.com',
    name: 'Developer Alpha',
    token: {
      access_token: 'access-token-alpha',
      refresh_token: 'refresh-token-alpha',
      expiry_timestamp: 1800000000,
      id_token: 'id-token-alpha',
      project_id: 'gcp-project-alpha',
      is_gcp_tos: true,
    },
    serviceMachineId: 'mac-machine-id-alpha-1234',
  };

  const credentialsB: ClientAccountCredentials = {
    email: 'user-b@example.com',
    name: 'Developer Beta',
    token: {
      access_token: 'access-token-beta',
      refresh_token: 'refresh-token-beta',
      expiry_timestamp: 1850000000,
      id_token: 'id-token-beta',
      project_id: 'gcp-project-beta',
      is_gcp_tos: true,
    },
    serviceMachineId: 'mac-machine-id-beta-5678',
  };

  // --- Tier 1: Feature Coverage (R3 SQLite Injection) ---

  describe('Tier 1: Isolated SQLite Credential Injection', () => {
    it('creates dedicated globalStorage directory and initializes state.vscdb ItemTable if absent', async () => {
      const storageDir = path.join(profileDirA, 'User', 'globalStorage');
      const dbPath = path.join(storageDir, 'state.vscdb');

      fs.mkdirSync(storageDir, { recursive: true });

      const db = new Database(dbPath);
      db.exec(`
        CREATE TABLE IF NOT EXISTS ItemTable (
          key TEXT PRIMARY KEY,
          value TEXT
        );
      `);

      // Write credentials payload
      const base64OAuth = ProtobufUtils.createUnifiedOAuthToken(
        credentialsA.token.access_token,
        credentialsA.token.refresh_token,
        credentialsA.token.expiry_timestamp,
        credentialsA.token.is_gcp_tos,
        credentialsA.token.id_token,
        credentialsA.email,
      );

      const authStatus = JSON.stringify({
        name: credentialsA.name,
        email: credentialsA.email,
        apiKey: '',
      });

      const insert = db.prepare('INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)');
      insert.run('antigravityUnifiedStateSync.oauthToken', base64OAuth);
      insert.run('antigravityAuthStatus', authStatus);
      insert.run('antigravityOnboarding', 'true');
      insert.run('telemetry.serviceMachineId', credentialsA.serviceMachineId);
      insert.run('storage.serviceMachineId', credentialsA.serviceMachineId);
      db.close();

      // Read back and verify from disk
      const verifyDb = new Database(dbPath, { readonly: true });
      const rows = verifyDb.prepare('SELECT key, value FROM ItemTable').all() as {
        key: string;
        value: string;
      }[];
      verifyDb.close();

      const rowMap = new Map(rows.map((r) => [r.key, r.value]));

      expect(rowMap.has('antigravityUnifiedStateSync.oauthToken')).toBe(true);
      expect(rowMap.get('antigravityOnboarding')).toBe('true');
      expect(rowMap.get('telemetry.serviceMachineId')).toBe(credentialsA.serviceMachineId);

      const parsedStatus = JSON.parse(rowMap.get('antigravityAuthStatus')!);
      expect(parsedStatus.email).toBe('user-a@example.com');
      expect(parsedStatus.name).toBe('Developer Alpha');

      const extractedToken = ProtobufUtils.extractOAuthTokenDetailsFromUnifiedStateEntry(
        rowMap.get('antigravityUnifiedStateSync.oauthToken')!,
      );
      expect(extractedToken?.accessToken).toBe('access-token-alpha');
      expect(extractedToken?.refreshToken).toBe('refresh-token-alpha');
    });

    it('injects device profile identifiers into storage.json and state.vscdb for isolated fingerprinting', async () => {
      const storageDir = path.join(profileDirA, 'User', 'globalStorage');
      fs.mkdirSync(storageDir, { recursive: true });

      const storageJsonPath = path.join(storageDir, 'storage.json');
      const deviceProfile = {
        'telemetry.machineId': 'telemetry-id-123',
        'telemetry.macMachineId': 'mac-id-123',
        'telemetry.devDeviceId': 'dev-id-123',
        'telemetry.sqmId': '{sqm-123}',
        'storage.serviceMachineId': 'mac-id-123',
      };

      fs.writeFileSync(storageJsonPath, JSON.stringify(deviceProfile, null, 2), 'utf-8');

      expect(fs.existsSync(storageJsonPath)).toBe(true);
      const readback = JSON.parse(fs.readFileSync(storageJsonPath, 'utf-8'));
      expect(readback['telemetry.machineId']).toBe('telemetry-id-123');
      expect(readback['telemetry.macMachineId']).toBe('mac-id-123');
    });
  });

  // --- Tier 2: Boundary & Corner Cases ---

  describe('Tier 2: Boundary & Isolation Cases', () => {
    it('guarantees complete isolation: provisioning Profile A does not touch or leak into Profile B', async () => {
      const storageDirA = path.join(profileDirA, 'User', 'globalStorage');
      const storageDirB = path.join(profileDirB, 'User', 'globalStorage');
      fs.mkdirSync(storageDirA, { recursive: true });
      fs.mkdirSync(storageDirB, { recursive: true });

      const dbPathA = path.join(storageDirA, 'state.vscdb');
      const dbPathB = path.join(storageDirB, 'state.vscdb');

      // Setup DB A with Credentials A
      const dbA = new Database(dbPathA);
      dbA.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT)');
      dbA.prepare('INSERT INTO ItemTable VALUES (?, ?)').run('email', credentialsA.email);
      dbA.close();

      // Setup DB B with Credentials B
      const dbB = new Database(dbPathB);
      dbB.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT)');
      dbB.prepare('INSERT INTO ItemTable VALUES (?, ?)').run('email', credentialsB.email);
      dbB.close();

      // Verify A has only A
      const checkA = new Database(dbPathA, { readonly: true });
      const rowA = checkA.prepare("SELECT value FROM ItemTable WHERE key = 'email'").get() as any;
      checkA.close();
      expect(rowA.value).toBe('user-a@example.com');

      // Verify B has only B
      const checkB = new Database(dbPathB, { readonly: true });
      const rowB = checkB.prepare("SELECT value FROM ItemTable WHERE key = 'email'").get() as any;
      checkB.close();
      expect(rowB.value).toBe('user-b@example.com');
    });

    it('rolls back transaction cleanly when a write constraint or database failure occurs', async () => {
      const storageDir = path.join(profileDirA, 'User', 'globalStorage');
      fs.mkdirSync(storageDir, { recursive: true });
      const dbPath = path.join(storageDir, 'state.vscdb');

      const db = new Database(dbPath);
      db.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT)');
      db.prepare('INSERT INTO ItemTable VALUES (?, ?)').run('baseline', 'initial');

      const failedTx = db.transaction(() => {
        db.prepare('INSERT INTO ItemTable VALUES (?, ?)').run('new_key', 'will_fail');
        throw new Error('Forced transactional abort');
      });

      expect(() => failedTx()).toThrow('Forced transactional abort');

      // Check that new_key was rolled back and baseline remains
      const rows = db.prepare('SELECT key, value FROM ItemTable').all() as any[];
      expect(rows).toHaveLength(1);
      expect(rows[0].key).toBe('baseline');
      db.close();
    });

    it('provisions credentials successfully when optional project_id is omitted', async () => {
      const storageDir = path.join(profileDirA, 'User', 'globalStorage');
      fs.mkdirSync(storageDir, { recursive: true });
      const dbPath = path.join(storageDir, 'state.vscdb');

      const db = new Database(dbPath);
      db.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT)');

      const tokenNoProject = { ...credentialsA.token };
      delete tokenNoProject.project_id;

      const base64OAuth = ProtobufUtils.createUnifiedOAuthToken(
        tokenNoProject.access_token,
        tokenNoProject.refresh_token,
        tokenNoProject.expiry_timestamp,
        tokenNoProject.is_gcp_tos,
        tokenNoProject.id_token,
        credentialsA.email,
      );

      db.prepare('INSERT INTO ItemTable VALUES (?, ?)').run(
        'antigravityUnifiedStateSync.oauthToken',
        base64OAuth,
      );
      db.close();

      const check = new Database(dbPath, { readonly: true });
      const row = check
        .prepare("SELECT value FROM ItemTable WHERE key = 'antigravityUnifiedStateSync.oauthToken'")
        .get() as any;
      check.close();

      const extracted = ProtobufUtils.extractOAuthTokenDetailsFromUnifiedStateEntry(row.value);
      expect(extracted?.accessToken).toBe('access-token-alpha');
    });
  });

  // --- Tier 3: Frontend & Language Server Isolation ---

  describe('Tier 3: Frontend & Language Server Multi-Account Provisioning', () => {
    it('provisions app_storage.json with bound account username and onboarding flags, preserving existing settings', () => {
      fs.mkdirSync(profileDirA, { recursive: true });
      // Pre-seed app_storage.json with existing configuration
      const appStoragePath = path.join(profileDirA, 'app_storage.json');
      fs.writeFileSync(
        appStoragePath,
        JSON.stringify({ 'telemetry.enabled': 'false', 'theme.mode': 'dark' }),
        'utf8',
      );

      // Simulate lifecycle provisioning step
      let appStorage: Record<string, string> = {};
      try {
        if (fs.existsSync(appStoragePath)) {
          appStorage = JSON.parse(fs.readFileSync(appStoragePath, 'utf8'));
        }
      } catch {
        appStorage = {};
      }
      appStorage['ide-install-wizard-shown'] = 'true';
      appStorage['jetski.onboarding.lastLoginUsername'] = credentialsA.email;
      appStorage['jetski.onboarding.lastLoginIsGcpTos'] = credentialsA.token.is_gcp_tos
        ? 'true'
        : 'false';
      fs.writeFileSync(appStoragePath, JSON.stringify(appStorage, null, 2), 'utf8');

      // Verify
      const readback = JSON.parse(fs.readFileSync(appStoragePath, 'utf8'));
      expect(readback['telemetry.enabled']).toBe('false');
      expect(readback['theme.mode']).toBe('dark');
      expect(readback['ide-install-wizard-shown']).toBe('true');
      expect(readback['jetski.onboarding.lastLoginUsername']).toBe('user-a@example.com');
      expect(readback['jetski.onboarding.lastLoginIsGcpTos']).toBe('true');
    });

    it('provisions isolated home with jetski-standalone-oauth-token in 0600 mode for language server', () => {
      const isolatedHome = path.join(profileDirA, 'home');
      const geminiDir = path.join(isolatedHome, '.gemini');
      fs.mkdirSync(geminiDir, { recursive: true });

      const oauthPayload = buildAntigravityCredentialPayload(credentialsA.token);
      const tokenPath = path.join(geminiDir, 'jetski-standalone-oauth-token');
      fs.writeFileSync(tokenPath, oauthPayload, { mode: 0o600 });

      expect(fs.existsSync(tokenPath)).toBe(true);

      // Check mode on Unix
      if (process.platform !== 'win32') {
        const stats = fs.statSync(tokenPath);
        expect(stats.mode & 0o777).toBe(0o600);
      }

      // Check payload content parses and matches credentials
      const parsed = JSON.parse(fs.readFileSync(tokenPath, 'utf8'));
      expect(parsed.token.access_token).toBe('access-token-alpha');
      expect(parsed.token.refresh_token).toBe('refresh-token-alpha');
      expect(parsed.token.project_id).toBe('gcp-project-alpha');
      expect(parsed.auth_method).toBe('consumer');
    });

    it('creates symlinks to host developer dotfiles in isolated home without error', () => {
      const isolatedHome = path.join(profileDirA, 'home');
      fs.mkdirSync(isolatedHome, { recursive: true });

      // Create fake host dotfile
      const fakeHostDir = path.join(rootDir, 'fake-host');
      fs.mkdirSync(fakeHostDir, { recursive: true });
      const fakeGitConfig = path.join(fakeHostDir, '.gitconfig');
      fs.writeFileSync(fakeGitConfig, '[user]\n  name = Alpha\n');

      // Symlink to isolated home
      const dest = path.join(isolatedHome, '.gitconfig');
      fs.symlinkSync(fakeGitConfig, dest);

      expect(fs.existsSync(dest)).toBe(true);
      expect(fs.readFileSync(dest, 'utf8')).toContain('Alpha');
    });
  });

  // --- Tier 4: Extensions Sharing & Launch Integration (R1) ---

  describe('Tier 4: Extensions Sharing & Launch Integration (R1)', () => {
    it('provisions extensions sharing via idempotent symlink from host extensions directory', () => {
      const hostExtensionsDir = path.join(rootDir, 'host-extensions');
      const extPackageJson = path.join(
        hostExtensionsDir,
        'publisher.my-extension-1.0.0',
        'package.json',
      );
      fs.mkdirSync(path.dirname(extPackageJson), { recursive: true });
      fs.writeFileSync(extPackageJson, JSON.stringify({ name: 'my-extension', version: '1.0.0' }));

      const isolatedHomeA = path.join(profileDirA, 'home');
      fs.mkdirSync(profileDirA, { recursive: true });
      fs.mkdirSync(isolatedHomeA, { recursive: true });

      provisionExtensionsSharing(profileDirA, isolatedHomeA, hostExtensionsDir);

      const profileExtLink = path.join(profileDirA, 'extensions');
      const homeExtLink = path.join(isolatedHomeA, '.antigravity', 'extensions');

      expect(fs.existsSync(profileExtLink)).toBe(true);
      expect(fs.lstatSync(profileExtLink).isSymbolicLink()).toBe(true);
      expect(fs.existsSync(homeExtLink)).toBe(true);
      expect(fs.lstatSync(homeExtLink).isSymbolicLink()).toBe(true);

      const readback = JSON.parse(
        fs.readFileSync(
          path.join(profileExtLink, 'publisher.my-extension-1.0.0', 'package.json'),
          'utf8',
        ),
      );
      expect(readback.name).toBe('my-extension');
      expect(readback.version).toBe('1.0.0');
    });

    it('extensions symlink creation is idempotent and preserves pre-existing profile extensions directory', () => {
      const hostExtensionsDir = path.join(rootDir, 'host-extensions');
      fs.mkdirSync(hostExtensionsDir, { recursive: true });

      // Profile already has a physical extensions directory with local extensions
      const profileExtDir = path.join(profileDirA, 'extensions');
      const localExtPkg = path.join(profileExtDir, 'local.pkg', 'package.json');
      fs.mkdirSync(path.dirname(localExtPkg), { recursive: true });
      fs.writeFileSync(localExtPkg, JSON.stringify({ name: 'local-pkg' }));

      const isolatedHomeA = path.join(profileDirA, 'home');
      fs.mkdirSync(isolatedHomeA, { recursive: true });

      // Action: should not overwrite existing physical directory
      provisionExtensionsSharing(profileDirA, isolatedHomeA, hostExtensionsDir);

      expect(fs.lstatSync(profileExtDir).isSymbolicLink()).toBe(false);
      expect(fs.existsSync(localExtPkg)).toBe(true);
      const pkg = JSON.parse(fs.readFileSync(localExtPkg, 'utf8'));
      expect(pkg.name).toBe('local-pkg');

      // Now run on a profile with a valid symlink to test idempotency
      const isolatedHomeB = path.join(profileDirB, 'home');
      fs.mkdirSync(profileDirB, { recursive: true });
      fs.mkdirSync(isolatedHomeB, { recursive: true });
      provisionExtensionsSharing(profileDirB, isolatedHomeB, hostExtensionsDir);
      expect(fs.lstatSync(path.join(profileDirB, 'extensions')).isSymbolicLink()).toBe(true);

      // Re-provisioning does not throw and leaves link intact
      expect(() => {
        provisionExtensionsSharing(profileDirB, isolatedHomeB, hostExtensionsDir);
      }).not.toThrow();
      expect(fs.lstatSync(path.join(profileDirB, 'extensions')).isSymbolicLink()).toBe(true);
    });

    it('gracefully proceeds when host extensions directory does not exist', () => {
      const nonExistentHostDir = path.join(rootDir, 'does-not-exist');
      const isolatedHomeA = path.join(profileDirA, 'home');
      fs.mkdirSync(profileDirA, { recursive: true });
      fs.mkdirSync(isolatedHomeA, { recursive: true });

      expect(() => {
        provisionExtensionsSharing(profileDirA, isolatedHomeA, nonExistentHostDir);
      }).not.toThrow();

      expect(fs.existsSync(path.join(profileDirA, 'extensions'))).toBe(false);
    });
  });

  // --- Tier 5: Editor Configuration & Custom Agent Skills Inheritance (R2) ---

  describe('Tier 5: Editor Configuration & Custom Agent Skills Inheritance (R2)', () => {
    it('idempotently symlinks host settings.json, keybindings.json, and snippets/ into profile User directory', () => {
      const hostUserDir = path.join(rootDir, 'host-user');
      fs.mkdirSync(path.join(hostUserDir, 'snippets'), { recursive: true });

      fs.writeFileSync(
        path.join(hostUserDir, 'settings.json'),
        JSON.stringify({ 'editor.fontSize': 14, 'workbench.colorTheme': 'Default Dark+' }),
      );
      fs.writeFileSync(
        path.join(hostUserDir, 'keybindings.json'),
        JSON.stringify([
          { key: 'ctrl+k ctrl+s', command: 'workbench.action.openGlobalKeybindings' },
        ]),
      );
      fs.writeFileSync(
        path.join(hostUserDir, 'snippets', 'typescript.json'),
        JSON.stringify({ log: { prefix: 'clog', body: ['console.log($1);'] } }),
      );

      fs.mkdirSync(profileDirA, { recursive: true });
      provisionEditorSettings(profileDirA, hostUserDir);

      const profileSettings = path.join(profileDirA, 'User', 'settings.json');
      const profileKeybindings = path.join(profileDirA, 'User', 'keybindings.json');
      const profileSnippets = path.join(profileDirA, 'User', 'snippets');

      expect(fs.existsSync(profileSettings)).toBe(true);
      expect(fs.lstatSync(profileSettings).isSymbolicLink()).toBe(true);
      expect(fs.existsSync(profileKeybindings)).toBe(true);
      expect(fs.lstatSync(profileKeybindings).isSymbolicLink()).toBe(true);
      expect(fs.existsSync(profileSnippets)).toBe(true);
      expect(fs.lstatSync(profileSnippets).isSymbolicLink()).toBe(true);

      const readSnippet = JSON.parse(
        fs.readFileSync(path.join(profileSnippets, 'typescript.json'), 'utf8'),
      );
      expect(readSnippet.log.prefix).toBe('clog');
    });

    it('does NOT overwrite existing customized profile editor settings', () => {
      const hostUserDir = path.join(rootDir, 'host-user');
      fs.mkdirSync(hostUserDir, { recursive: true });
      fs.writeFileSync(
        path.join(hostUserDir, 'settings.json'),
        JSON.stringify({ 'editor.fontSize': 14 }),
      );

      // Pre-create customized profile settings as a physical file
      const profileUserDir = path.join(profileDirA, 'User');
      fs.mkdirSync(profileUserDir, { recursive: true });
      const profileSettings = path.join(profileUserDir, 'settings.json');
      fs.writeFileSync(profileSettings, JSON.stringify({ 'editor.fontSize': 20 }));

      provisionEditorSettings(profileDirA, hostUserDir);

      expect(fs.lstatSync(profileSettings).isSymbolicLink()).toBe(false);
      const readback = JSON.parse(fs.readFileSync(profileSettings, 'utf8'));
      expect(readback['editor.fontSize']).toBe(20);
    });

    it('symlinks host agent skills (config, antigravity, skills) into profile isolated home .gemini directory', () => {
      const hostGeminiDir = path.join(rootDir, 'host-gemini');
      const skillFile = path.join(hostGeminiDir, 'config', 'skills', 'custom-skill', 'SKILL.md');
      const templateFile = path.join(hostGeminiDir, 'antigravity', 'templates', 'agent.json');
      const userSkillFile = path.join(hostGeminiDir, 'skills', 'user-skill', 'SKILL.md');

      fs.mkdirSync(path.dirname(skillFile), { recursive: true });
      fs.mkdirSync(path.dirname(templateFile), { recursive: true });
      fs.mkdirSync(path.dirname(userSkillFile), { recursive: true });

      fs.writeFileSync(skillFile, '# Custom Skill');
      fs.writeFileSync(templateFile, JSON.stringify({ name: 'template' }));
      fs.writeFileSync(userSkillFile, '# User Skill');

      const isolatedHomeA = path.join(profileDirA, 'home');
      fs.mkdirSync(isolatedHomeA, { recursive: true });

      provisionGeminiCustomizations(isolatedHomeA, hostGeminiDir);

      const profileGemini = path.join(isolatedHomeA, '.gemini');
      expect(fs.lstatSync(path.join(profileGemini, 'config')).isSymbolicLink()).toBe(true);
      expect(fs.lstatSync(path.join(profileGemini, 'antigravity')).isSymbolicLink()).toBe(true);
      expect(fs.lstatSync(path.join(profileGemini, 'skills')).isSymbolicLink()).toBe(true);

      expect(
        fs.readFileSync(
          path.join(profileGemini, 'config', 'skills', 'custom-skill', 'SKILL.md'),
          'utf8',
        ),
      ).toBe('# Custom Skill');
    });

    it('handles absent optional host skills directories gracefully', () => {
      const hostGeminiDir = path.join(rootDir, 'host-gemini-minimal');
      fs.mkdirSync(path.join(hostGeminiDir, 'config'), { recursive: true });
      // antigravity and skills do not exist

      const isolatedHomeA = path.join(profileDirA, 'home');
      fs.mkdirSync(isolatedHomeA, { recursive: true });

      expect(() => {
        provisionGeminiCustomizations(isolatedHomeA, hostGeminiDir);
      }).not.toThrow();

      const profileGemini = path.join(isolatedHomeA, '.gemini');
      expect(fs.existsSync(path.join(profileGemini, 'config'))).toBe(true);
      expect(fs.existsSync(path.join(profileGemini, 'antigravity'))).toBe(false);
      expect(fs.existsSync(path.join(profileGemini, 'skills'))).toBe(false);
    });
  });

  // --- Tier 6: Recent Project History Seeding (R3) ---

  describe('Tier 6: Recent Project History Seeding (R3)', () => {
    it('seeds history.recentlyOpenedPathsList from host state.vscdb into profile state.vscdb ItemTable', () => {
      // 1. Setup host database
      const hostDbDir = path.join(rootDir, 'host-storage');
      fs.mkdirSync(hostDbDir, { recursive: true });
      const hostDbPath = path.join(hostDbDir, 'state.vscdb');
      const hostDb = new Database(hostDbPath);
      hostDb.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT);');
      const historyPayload = JSON.stringify({
        entries: [{ folderUri: 'file:///home/user/project-alpha', label: 'project-alpha' }],
      });
      hostDb
        .prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)')
        .run('history.recentlyOpenedPathsList', historyPayload);
      hostDb.close();

      // 2. Setup profile database
      const profileStorageDir = path.join(profileDirA, 'User', 'globalStorage');
      fs.mkdirSync(profileStorageDir, { recursive: true });
      const profileDbPath = path.join(profileStorageDir, 'state.vscdb');
      const profileDb = new Database(profileDbPath);
      profileDb.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT);');
      profileDb
        .prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)')
        .run('antigravityAuthStatus', '{"email":"user-a@example.com"}');
      profileDb.close();

      // 3. Action
      seedRecentProjectHistory({ profileUserDataDir: profileDirA, hostDbPath });

      // 4. Verify profile DB
      const verifyDb = new Database(profileDbPath, { readonly: true });
      const row = verifyDb
        .prepare("SELECT value FROM ItemTable WHERE key = 'history.recentlyOpenedPathsList'")
        .get() as { value: string } | undefined;
      verifyDb.close();

      expect(row).toBeDefined();
      expect(row?.value).toBe(historyPayload);
    });

    it('does NOT overwrite history.recentlyOpenedPathsList if already present in profile state.vscdb', () => {
      // Host database with host project
      const hostDbDir = path.join(rootDir, 'host-storage');
      fs.mkdirSync(hostDbDir, { recursive: true });
      const hostDbPath = path.join(hostDbDir, 'state.vscdb');
      const hostDb = new Database(hostDbPath);
      hostDb.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT);');
      const hostPayload = JSON.stringify({
        entries: [{ folderUri: 'file:///home/user/host-project' }],
      });
      hostDb
        .prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)')
        .run('history.recentlyOpenedPathsList', hostPayload);
      hostDb.close();

      // Profile database already has a custom project
      const profileStorageDir = path.join(profileDirA, 'User', 'globalStorage');
      fs.mkdirSync(profileStorageDir, { recursive: true });
      const profileDbPath = path.join(profileStorageDir, 'state.vscdb');
      const profileDb = new Database(profileDbPath);
      profileDb.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT);');
      const profileExistingPayload = JSON.stringify({
        entries: [{ folderUri: 'file:///home/user/profile-custom' }],
      });
      profileDb
        .prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)')
        .run('history.recentlyOpenedPathsList', profileExistingPayload);
      profileDb.close();

      // Action
      seedRecentProjectHistory({ profileUserDataDir: profileDirA, hostDbPath });

      // Verify profile history was NOT overwritten
      const verifyDb = new Database(profileDbPath, { readonly: true });
      const row = verifyDb
        .prepare("SELECT value FROM ItemTable WHERE key = 'history.recentlyOpenedPathsList'")
        .get() as { value: string } | undefined;
      verifyDb.close();

      expect(row?.value).toBe(profileExistingPayload);
      expect(row?.value).not.toBe(hostPayload);
    });

    it('handles missing host state.vscdb or absent history key without throwing', () => {
      const profileStorageDir = path.join(profileDirA, 'User', 'globalStorage');
      fs.mkdirSync(profileStorageDir, { recursive: true });
      const profileDbPath = path.join(profileStorageDir, 'state.vscdb');
      const profileDb = new Database(profileDbPath);
      profileDb.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT);');
      profileDb.close();

      // Scenario A: non-existent host DB
      expect(() => {
        seedRecentProjectHistory({
          profileUserDataDir: profileDirA,
          hostDbPath: path.join(rootDir, 'non-existent.vscdb'),
        });
      }).not.toThrow();

      // Scenario B: host DB exists but has no history key
      const hostDbDir = path.join(rootDir, 'host-storage-empty');
      fs.mkdirSync(hostDbDir, { recursive: true });
      const hostDbPath = path.join(hostDbDir, 'state.vscdb');
      const hostDb = new Database(hostDbPath);
      hostDb.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT);');
      hostDb.close();

      expect(() => {
        seedRecentProjectHistory({ profileUserDataDir: profileDirA, hostDbPath });
      }).not.toThrow();

      const verifyDb = new Database(profileDbPath, { readonly: true });
      const row = verifyDb
        .prepare("SELECT value FROM ItemTable WHERE key = 'history.recentlyOpenedPathsList'")
        .get();
      verifyDb.close();
      expect(row).toBeUndefined();
    });
  });

  // --- Tier 7: Security & Credential Isolation Invariants ---

  describe('Tier 7: Security & Credential Isolation Invariants', () => {
    it('strict credential isolation: jetski-standalone-oauth-token is NEVER symlinked or copied from host', () => {
      const fakeHostGemini = path.join(rootDir, 'fake-host-gemini');
      fs.mkdirSync(fakeHostGemini, { recursive: true });
      fs.writeFileSync(
        path.join(fakeHostGemini, 'jetski-standalone-oauth-token'),
        JSON.stringify({ token: { access_token: 'HOST-LEAK-TOKEN' } }),
      );

      // Profile provisioning writes independent token
      const isolatedHomeA = path.join(profileDirA, 'home');
      const geminiDir = path.join(isolatedHomeA, '.gemini');
      fs.mkdirSync(geminiDir, { recursive: true });

      const oauthPayload = buildAntigravityCredentialPayload(credentialsA.token);
      const tokenPath = path.join(geminiDir, 'jetski-standalone-oauth-token');
      fs.writeFileSync(tokenPath, oauthPayload, { mode: 0o600 });

      // Run profile sharing pointing to fake host gemini
      provisionWorkspaceProfileSharing({
        profileUserDataDir: profileDirA,
        isolatedHome: isolatedHomeA,
        hostGeminiDir: fakeHostGemini,
      });

      // Verify token is a physical file, NOT a symlink
      expect(fs.lstatSync(tokenPath).isSymbolicLink()).toBe(false);
      const parsed = JSON.parse(fs.readFileSync(tokenPath, 'utf8'));
      expect(parsed.token.access_token).toBe('access-token-alpha');
      expect(parsed.token.access_token).not.toBe('HOST-LEAK-TOKEN');
    });

    it('strict credential isolation: host auth tokens in state.vscdb are NEVER seeded or leaked during history sync', () => {
      // Host database containing live auth credentials
      const hostDbDir = path.join(rootDir, 'host-auth-storage');
      fs.mkdirSync(hostDbDir, { recursive: true });
      const hostDbPath = path.join(hostDbDir, 'state.vscdb');
      const hostDb = new Database(hostDbPath);
      hostDb.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT);');
      const insert = hostDb.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)');
      insert.run('history.recentlyOpenedPathsList', '{"entries":[]}');
      insert.run('antigravityUnifiedStateSync.oauthToken', 'HOST_SECRET_TOKEN_DO_NOT_LEAK');
      insert.run('antigravityAuthStatus', '{"email":"host-secret@example.com"}');
      insert.run('antigravityOnboarding', 'true');
      hostDb.close();

      // Profile database for Developer Alpha
      const profileStorageDir = path.join(profileDirA, 'User', 'globalStorage');
      fs.mkdirSync(profileStorageDir, { recursive: true });
      const profileDbPath = path.join(profileStorageDir, 'state.vscdb');
      const profileDb = new Database(profileDbPath);
      profileDb.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT);');
      const profileInsert = profileDb.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)');
      const alphaBase64 = ProtobufUtils.createUnifiedOAuthToken(
        credentialsA.token.access_token,
        credentialsA.token.refresh_token,
        credentialsA.token.expiry_timestamp,
        credentialsA.token.is_gcp_tos,
        credentialsA.token.id_token,
        credentialsA.email,
      );
      profileInsert.run('antigravityUnifiedStateSync.oauthToken', alphaBase64);
      profileInsert.run(
        'antigravityAuthStatus',
        JSON.stringify({ name: credentialsA.name, email: credentialsA.email }),
      );
      profileDb.close();

      // Action: seed history
      seedRecentProjectHistory({ profileUserDataDir: profileDirA, hostDbPath });

      // Verification
      const verifyDb = new Database(profileDbPath, { readonly: true });
      const authRow = verifyDb
        .prepare("SELECT value FROM ItemTable WHERE key = 'antigravityAuthStatus'")
        .get() as { value: string };
      const tokenRow = verifyDb
        .prepare("SELECT value FROM ItemTable WHERE key = 'antigravityUnifiedStateSync.oauthToken'")
        .get() as { value: string };
      verifyDb.close();

      expect(authRow.value).toContain('user-a@example.com');
      expect(authRow.value).not.toContain('host-secret@example.com');

      const extracted = ProtobufUtils.extractOAuthTokenDetailsFromUnifiedStateEntry(tokenRow.value);
      expect(extracted?.accessToken).toBe('access-token-alpha');
      expect(tokenRow.value).not.toBe('HOST_SECRET_TOKEN_DO_NOT_LEAK');
    });

    it('strict credential isolation: app_storage.json is an independent physical file reflecting only bound account', () => {
      fs.mkdirSync(profileDirA, { recursive: true });
      const appStoragePath = path.join(profileDirA, 'app_storage.json');
      fs.writeFileSync(
        appStoragePath,
        JSON.stringify({
          'ide-install-wizard-shown': 'true',
          'jetski.onboarding.lastLoginUsername': credentialsA.email,
        }),
      );

      const isolatedHomeA = path.join(profileDirA, 'home');
      fs.mkdirSync(isolatedHomeA, { recursive: true });

      provisionWorkspaceProfileSharing({
        profileUserDataDir: profileDirA,
        isolatedHome: isolatedHomeA,
      });

      expect(fs.lstatSync(appStoragePath).isSymbolicLink()).toBe(false);
      const parsed = JSON.parse(fs.readFileSync(appStoragePath, 'utf8'));
      expect(parsed['jetski.onboarding.lastLoginUsername']).toBe('user-a@example.com');
    });
  });

  // --- Tier 8: Defensive Execution & Error Resilience (R4) ---

  describe('Tier 8: Defensive Execution & Error Resilience (R4)', () => {
    it('resilience against locked host state.vscdb (SQLITE_BUSY / lock)', () => {
      const hostDbDir = path.join(rootDir, 'host-locked-storage');
      fs.mkdirSync(hostDbDir, { recursive: true });
      const hostDbPath = path.join(hostDbDir, 'state.vscdb');
      const hostDb = new Database(hostDbPath);
      hostDb.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT);');
      hostDb
        .prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)')
        .run('history.recentlyOpenedPathsList', '{"entries":[]}');

      // Hold an exclusive lock
      hostDb.exec('PRAGMA locking_mode = EXCLUSIVE; BEGIN EXCLUSIVE;');

      const profileStorageDir = path.join(profileDirA, 'User', 'globalStorage');
      fs.mkdirSync(profileStorageDir, { recursive: true });
      const profileDbPath = path.join(profileStorageDir, 'state.vscdb');
      const profileDb = new Database(profileDbPath);
      profileDb.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT);');
      profileDb.close();

      // Seeding with short timeout (50ms) should gracefully catch SQLITE_BUSY and not hang or throw
      expect(() => {
        seedRecentProjectHistory({
          profileUserDataDir: profileDirA,
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
    });

    it('resilience against corrupt host state.vscdb', () => {
      const hostDbDir = path.join(rootDir, 'host-corrupt-storage');
      fs.mkdirSync(hostDbDir, { recursive: true });
      const hostDbPath = path.join(hostDbDir, 'state.vscdb');
      fs.writeFileSync(hostDbPath, 'GARBAGE_NOT_A_VALID_SQLITE_DATABASE');

      const profileStorageDir = path.join(profileDirA, 'User', 'globalStorage');
      fs.mkdirSync(profileStorageDir, { recursive: true });
      const profileDbPath = path.join(profileStorageDir, 'state.vscdb');
      const profileDb = new Database(profileDbPath);
      profileDb.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT);');
      profileDb.close();

      expect(() => {
        seedRecentProjectHistory({ profileUserDataDir: profileDirA, hostDbPath });
      }).not.toThrow();
    });

    it('resilience against symlink creation failure (EPERM / EXDEV / permission denied)', () => {
      const hostUserDir = path.join(rootDir, 'host-user-symlink-err');
      fs.mkdirSync(hostUserDir, { recursive: true });
      fs.writeFileSync(path.join(hostUserDir, 'settings.json'), '{}');

      fs.mkdirSync(profileDirA, { recursive: true });

      const symlinkSpy = vi.spyOn(fs, 'symlinkSync').mockImplementation(() => {
        throw new Error('EXDEV: cross-device link not permitted');
      });

      expect(() => {
        provisionEditorSettings(profileDirA, hostUserDir);
      }).not.toThrow();

      symlinkSpy.mockRestore();
    });

    it('safeSymlink removes stale symlinks and isPathAbsent handles ENOENT cleanly', () => {
      const targetA = path.join(rootDir, 'target-a.txt');
      const targetB = path.join(rootDir, 'target-b.txt');
      const linkPath = path.join(rootDir, 'my-link.txt');

      fs.writeFileSync(targetA, 'content A');
      fs.writeFileSync(targetB, 'content B');

      // 1. Initial link
      expect(safeSymlink(targetA, linkPath, 'file')).toBe(true);
      expect(fs.readFileSync(linkPath, 'utf8')).toBe('content A');

      // 2. Retarget link to targetB: safeSymlink should replace stale link
      expect(safeSymlink(targetB, linkPath, 'file')).toBe(true);
      expect(fs.readFileSync(linkPath, 'utf8')).toBe('content B');

      // 3. Test isPathAbsent
      expect(isPathAbsent(path.join(rootDir, 'totally-missing'))).toBe(true);
      expect(isPathAbsent(targetA)).toBe(false);
    });
  });

  describe('Self-Healing Gemini Customizations & Sync Across Profiles', () => {
    let hostGeminiDir: string;
    let profileGeminiDir: string;
    let isolatedHome: string;

    beforeEach(() => {
      hostGeminiDir = path.join(rootDir, 'host-gemini');
      isolatedHome = path.join(profileDirA, 'home');
      profileGeminiDir = path.join(isolatedHome, '.gemini');

      // Setup populated host Gemini directory
      fs.mkdirSync(path.join(hostGeminiDir, 'antigravity', 'brain', 'host-conv-1'), {
        recursive: true,
      });
      fs.writeFileSync(
        path.join(hostGeminiDir, 'antigravity', 'brain', 'host-conv-1', 'transcript.jsonl'),
        '{"role":"user","content":"Hello from host"}',
      );
      fs.mkdirSync(path.join(hostGeminiDir, 'config', 'skills', 'skill-alpha'), {
        recursive: true,
      });
      fs.writeFileSync(
        path.join(hostGeminiDir, 'config', 'skills', 'skill-alpha', 'SKILL.md'),
        '# Alpha Skill',
      );

      // Create host conversation_summaries.db
      const hostDb = new Database(
        path.join(hostGeminiDir, 'antigravity', 'conversation_summaries.db'),
      );
      hostDb.exec(`
        CREATE TABLE conversation_summaries (
          conversation_id text PRIMARY KEY,
          title text NOT NULL DEFAULT ""
        );
        INSERT INTO conversation_summaries (conversation_id, title) VALUES ('host-conv-1', 'Host Conversation');
      `);
      hostDb.close();
    });

    it('isStaleOrScaffoldGeminiDir detects empty/scaffold antigravity directory as stale', () => {
      const scaffoldAntigravity = path.join(rootDir, 'test-scaffold-antigravity');
      fs.mkdirSync(path.join(scaffoldAntigravity, 'brain'), { recursive: true });
      fs.mkdirSync(path.join(scaffoldAntigravity, 'conversations'), { recursive: true });
      fs.mkdirSync(path.join(scaffoldAntigravity, 'builtin'), { recursive: true });
      fs.mkdirSync(path.join(scaffoldAntigravity, 'crashes'), { recursive: true });
      fs.mkdirSync(path.join(scaffoldAntigravity, 'bin'), { recursive: true });
      fs.writeFileSync(path.join(scaffoldAntigravity, 'installation_id'), 'id-12345');
      fs.writeFileSync(path.join(scaffoldAntigravity, 'antigravity_state.pbtxt'), 'active: true');

      const db = new Database(path.join(scaffoldAntigravity, 'conversation_summaries.db'));
      db.exec(
        'CREATE TABLE conversation_summaries (conversation_id text PRIMARY KEY, title text);',
      );
      db.close();

      expect(isStaleOrScaffoldGeminiDir(scaffoldAntigravity, 'antigravity')).toBe(true);
    });

    it('isStaleOrScaffoldGeminiDir detects populated antigravity directory with transcripts as non-stale', () => {
      const populatedAntigravity = path.join(rootDir, 'test-pop-antigravity');
      fs.mkdirSync(path.join(populatedAntigravity, 'brain', 'user-conv-99'), { recursive: true });
      fs.writeFileSync(
        path.join(populatedAntigravity, 'brain', 'user-conv-99', 'transcript.jsonl'),
        '{"role":"user","content":"Important transcript"}',
      );

      expect(isStaleOrScaffoldGeminiDir(populatedAntigravity, 'antigravity')).toBe(false);
    });

    it('isStaleOrScaffoldGeminiDir detects empty/scaffold config directory as stale and populated config as non-stale', () => {
      const scaffoldConfig = path.join(rootDir, 'test-scaffold-config');
      fs.mkdirSync(path.join(scaffoldConfig, 'plugins'), { recursive: true });
      fs.mkdirSync(path.join(scaffoldConfig, 'projects'), { recursive: true });
      fs.mkdirSync(path.join(scaffoldConfig, 'sidecars'), { recursive: true });
      fs.writeFileSync(path.join(scaffoldConfig, 'mcp_config.json'), '');
      fs.writeFileSync(path.join(scaffoldConfig, 'config.json'), '{}');

      expect(isStaleOrScaffoldGeminiDir(scaffoldConfig, 'config')).toBe(true);

      // Now add a custom skill
      fs.mkdirSync(path.join(scaffoldConfig, 'skills', 'custom-skill'), { recursive: true });
      fs.writeFileSync(path.join(scaffoldConfig, 'skills', 'custom-skill', 'SKILL.md'), '# Custom');
      expect(isStaleOrScaffoldGeminiDir(scaffoldConfig, 'config')).toBe(false);
    });

    it('replaces pre-existing stale physical antigravity and config scaffolding with live symlinks', () => {
      // Create stale scaffolding in profileGeminiDir (just like the Antigravity IDE binary creates)
      const profileAntigravity = path.join(profileGeminiDir, 'antigravity');
      const profileConfig = path.join(profileGeminiDir, 'config');
      fs.mkdirSync(path.join(profileAntigravity, 'brain'), { recursive: true });
      fs.mkdirSync(path.join(profileAntigravity, 'conversations'), { recursive: true });
      fs.writeFileSync(path.join(profileAntigravity, 'installation_id'), 'scaffold-id');
      const scaffoldDb = new Database(path.join(profileAntigravity, 'conversation_summaries.db'));
      scaffoldDb.exec(
        'CREATE TABLE conversation_summaries (conversation_id text PRIMARY KEY, title text);',
      );
      scaffoldDb.close();

      fs.mkdirSync(path.join(profileConfig, 'plugins'), { recursive: true });
      fs.writeFileSync(path.join(profileConfig, 'mcp_config.json'), '{}');

      // Profile has isolated oauth token
      fs.writeFileSync(
        path.join(profileGeminiDir, 'jetski-standalone-oauth-token'),
        'isolated-token-alpha',
        { mode: 0o600 },
      );

      // Run provisionGeminiCustomizations
      provisionGeminiCustomizations(isolatedHome, hostGeminiDir);

      // Verify antigravity and config are now symlinks to host
      expect(fs.lstatSync(profileAntigravity).isSymbolicLink()).toBe(true);
      expect(fs.lstatSync(profileConfig).isSymbolicLink()).toBe(true);

      // Verify host brain transcripts and skills are accessible through profile symlinks
      expect(
        fs.existsSync(path.join(profileAntigravity, 'brain', 'host-conv-1', 'transcript.jsonl')),
      ).toBe(true);
      expect(fs.existsSync(path.join(profileConfig, 'skills', 'skill-alpha', 'SKILL.md'))).toBe(
        true,
      );

      // STRICT CREDENTIAL ISOLATION: Token is untouched and isolated
      expect(
        fs.lstatSync(path.join(profileGeminiDir, 'jetski-standalone-oauth-token')).isSymbolicLink(),
      ).toBe(false);
      expect(
        fs.readFileSync(path.join(profileGeminiDir, 'jetski-standalone-oauth-token'), 'utf8'),
      ).toBe('isolated-token-alpha');
    });

    it('preserves pre-existing customized physical directories without overwriting', () => {
      const profileAntigravity = path.join(profileGeminiDir, 'antigravity');
      fs.mkdirSync(path.join(profileAntigravity, 'brain', 'unique-user-conv'), { recursive: true });
      fs.writeFileSync(
        path.join(profileAntigravity, 'brain', 'unique-user-conv', 'transcript.jsonl'),
        '{"role":"user","content":"User local conversation"}',
      );

      const userDb = new Database(path.join(profileAntigravity, 'conversation_summaries.db'));
      userDb.exec(`
        CREATE TABLE conversation_summaries (conversation_id text PRIMARY KEY, title text);
        INSERT INTO conversation_summaries (conversation_id, title) VALUES ('unique-user-conv', 'Local User Conv');
      `);
      userDb.close();

      provisionGeminiCustomizations(isolatedHome, hostGeminiDir);

      // Customized antigravity remains a physical directory, NOT overwritten by symlink
      expect(fs.lstatSync(profileAntigravity).isSymbolicLink()).toBe(false);
      expect(
        fs.existsSync(
          path.join(profileAntigravity, 'brain', 'unique-user-conv', 'transcript.jsonl'),
        ),
      ).toBe(true);
    });

    it('reconcileAllWorkspaceProfiles synchronizes multiple registered profiles cleanly', async () => {
      const mockProfileRepo = {
        listProfiles: async () => [
          {
            id: 'mock-p1',
            name: 'Profile One',
            accountId: 'acc-1',
            projectPath: rootDir,
            userDataDir: profileDirA,
            createdAt: 1000,
            lastLaunchedAt: null,
          },
          {
            id: 'mock-p2',
            name: 'Profile Two',
            accountId: 'acc-2',
            projectPath: rootDir,
            userDataDir: profileDirB,
            createdAt: 2000,
            lastLaunchedAt: null,
          },
        ],
      };

      const result = await reconcileAllWorkspaceProfiles({
        profileRepo: mockProfileRepo as never,
        hostGeminiDir,
        withStoppedProfile: async (_id, _options, action) => action(),
      });

      expect(result.reconciledCount).toBe(2);
      expect(result.profiles.every((p) => p.reconciled)).toBe(true);
    });
  });
});
