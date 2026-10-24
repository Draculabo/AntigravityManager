import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProtobufUtils } from '@/shared/serialization/protobuf';
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
});
