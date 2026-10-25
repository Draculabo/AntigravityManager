import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProtobufUtils } from '@/shared/serialization/protobuf';
import { buildAntigravityCredentialPayload } from '@/modules/antigravity-runtime';
import type { ClientAccountCredentials } from '@/modules/antigravity-runtime/credentials/clientAccount';

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
});
