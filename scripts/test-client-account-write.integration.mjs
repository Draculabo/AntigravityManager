// Uses synthetic credentials and isolated files; it never opens an installed client's state.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module, { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import ts from 'typescript';

const require = createRequire(import.meta.url);
if (process.platform === 'win32' && !process.versions.electron) {
  const result = spawnSync(require('electron'), [fileURLToPath(import.meta.url)], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    encoding: 'utf8',
    timeout: 30000,
  });
  process.stdout.write(result.stdout ?? '');
  process.stderr.write(result.stderr ?? '');
  if (result.error) {
    throw result.error;
  }
  process.exit(result.status ?? 1);
}

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const base = fs.realpathSync(os.tmpdir());
const root = fs.mkdtempSync(path.join(base, 'agm-client-write-'));
assert(path.resolve(root).startsWith(base + path.sep));
const primary = path.join(root, 'User', 'globalStorage', 'state.vscdb');
fs.mkdirSync(path.dirname(primary), { recursive: true });
const originalResolve = Module._resolveFilename;
const originalLoad = Module._load;
const nativeWindows = process.platform === 'win32';
const credentialService = 'AntigravityManager.Acceptance.' + path.basename(root);
const credentialAccount = 'synthetic';
const credentialTarget = credentialService + ':' + credentialAccount;
const nativeDependencies = process.env.AGM_CLIENT_NATIVE_DEPS;
const NativeDatabase = nativeDependencies
  ? createRequire(path.join(nativeDependencies, 'package.json'))('better-sqlite3')
  : require('better-sqlite3');
Module._resolveFilename = function (request, ...args) {
  return originalResolve.call(
    this,
    request.startsWith('@/') ? path.join(repo, 'src', request.slice(2)) : request,
    ...args,
  );
};
Module._load = function (request, ...args) {
  if (nativeWindows && request === './windowsCredentialStore') {
    const store = originalLoad.call(this, request, ...args);
    return {
      readWindowsCredential: async (target) => {
        assert.equal(target, 'gemini:antigravity');
        return store.readWindowsCredential(credentialTarget);
      },
      writeWindowsCredential: async (target, account, payload) => {
        assert.deepEqual([target, account], ['gemini:antigravity', 'antigravity']);
        await store.writeWindowsCredential(credentialTarget, credentialAccount, payload);
        const records = await require('keytar').findCredentials(credentialTarget);
        assert.deepEqual(records, [{ account: credentialAccount, password: payload }]);
      },
    };
  }
  if (nativeWindows && request === './agyCliTokenStore') {
    return { writeAgyCliToken() {} };
  }
  if (nativeWindows && request === './googleOAuthCredentialStore') {
    return { writeGoogleOAuthCredentials() {} };
  }
  if (request === 'better-sqlite3') {
    return NativeDatabase;
  }
  if (request === '@/shared/platform/paths') {
    return {
      getAntigravityDbPaths: () => [primary],
      getAntigravityExecutablePath: () => undefined,
    };
  }
  if (request === '@/shared/logging/logger') {
    return { logger: { info() {}, warn() {}, error() {}, debug() {} } };
  }
  if (request === '@/modules/antigravity-runtime') {
    return {
      ...require('../src/modules/antigravity-runtime/credentials/clientAccountWrite.ts'),
      prepareLaunchContext: async () => ({ pathOptions: { userDataDir: root } }),
      ...require('../src/modules/antigravity-runtime/credentials/antigravityCredentialStore.ts'),
    };
  }
  return originalLoad.call(this, request, ...args);
};
require.extensions['.ts'] = (module, filename) => {
  const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  }).outputText;
  module._compile(code, filename);
};

let database;
try {
  const Database = require('better-sqlite3');
  const {
    prepareClientAccountWrite,
  } = require('../src/modules/antigravity-runtime/credentials/clientAccountWrite.ts');
  const {
    backupAccount,
    restoreAccount,
  } = require('../src/modules/account/persistence/antigravity-state-database.ts');
  const {
    credentialsFromAccountBackup,
  } = require('../src/modules/account/persistence/snapshotCredentials.ts');
  const { ProtobufUtils } = require('../src/shared/serialization/protobuf.ts');
  database = new Database(primary);
  database.pragma('journal_mode = WAL');
  database.pragma('wal_autocheckpoint = 0');
  database.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT)');
  const insert = database.prepare('INSERT OR REPLACE INTO ItemTable (key,value) VALUES (?,?)');
  const account = (id) => ({
    email: id + '@example.invalid',
    name: id,
    token: {
      access_token: 'synthetic-access-' + id,
      refresh_token: 'synthetic-refresh-' + id,
      expiry_timestamp: 1900000000,
      id_token: 'synthetic-id-' + id,
      ...(id === 'a' ? { project_id: 'synthetic-project-a' } : {}),
    },
  });
  const a = account('a');
  const b = account('b');
  insert.run('workspace.keep', 'workspace-state');
  const previousTopic = ProtobufUtils.createUnifiedStateEntry(
    'unrelatedSentinel',
    new Uint8Array([4, 5, 6]),
  );
  insert.run('antigravityUnifiedStateSync.oauthToken', previousTopic);
  const recoveryPath = primary.replace(/\.vscdb$/, '.vscdb.backup');
  fs.writeFileSync(recoveryPath, 'untouched-client-recovery');

  const first = await prepareClientAccountWrite(a, 'ide', { userDataDir: root });
  await first.write();
  const captured = await backupAccount(
    { id: 'a', email: a.email, name: a.name, created_at: '2026-01-01', last_used: '2026-01-01' },
    'ide',
    { userDataDir: root },
  );
  assert.deepEqual(credentialsFromAccountBackup(captured), {
    ...a,
    token: { ...a.token, is_gcp_tos: false },
  });
  const second = await prepareClientAccountWrite(b, 'ide', { userDataDir: root });
  await second.write();
  await second.write();
  const read = (key) =>
    database.prepare('SELECT value FROM ItemTable WHERE key = ?').get(key)?.value;
  assert.equal(read('antigravityUnifiedStateSync.enterprisePreferences'), undefined);
  const backup = new Database(primary + '.account-switch.backup', { readonly: true });
  assert.equal(
    JSON.parse(
      backup.prepare("SELECT value FROM ItemTable WHERE key='antigravityAuthStatus'").get().value,
    ).email,
    a.email,
  );
  backup.close();
  await restoreAccount(captured, 'ide', { userDataDir: root });
  const token = ProtobufUtils.extractOAuthTokenDetailsFromUnifiedStateEntry(
    read('antigravityUnifiedStateSync.oauthToken'),
  );
  assert.equal(token.accessToken, a.token.access_token);
  assert.equal(token.idToken, a.token.id_token);
  assert.equal(read('workspace.keep'), 'workspace-state');
  assert.equal(fs.readFileSync(recoveryPath, 'utf8'), 'untouched-client-recovery');
  if (nativeWindows) {
    const {
      readAntigravityCredentialStoreToken,
    } = require('../src/modules/antigravity-runtime/credentials/antigravityCredentialStore.ts');
    for (const selected of [a, b, a]) {
      const writer = await prepareClientAccountWrite(selected, 'agy');
      await writer.write();
      const expected = {
        accessToken: selected.token.access_token,
        refreshToken: selected.token.refresh_token,
        expiryTimestamp: selected.token.expiry_timestamp,
        idToken: selected.token.id_token,
        ...(selected.token.project_id ? { projectId: selected.token.project_id } : {}),
      };
      assert.deepEqual(await readAntigravityCredentialStoreToken(), expected);
      assert.deepEqual(await readAntigravityCredentialStoreToken(), expected);
    }
  }
  const rowsBeforeFailure = database.prepare('SELECT * FROM ItemTable ORDER BY key').all();
  database.exec(
    "CREATE TRIGGER reject_auth BEFORE INSERT ON ItemTable WHEN NEW.key='antigravityAuthStatus' BEGIN SELECT RAISE(ABORT,'fixture-write-failed'); END",
  );
  const failed = await prepareClientAccountWrite(b, 'ide', { userDataDir: root });
  await assert.rejects(failed.write(), /fixture-write-failed/);
  assert.deepEqual(
    database.prepare('SELECT * FROM ItemTable ORDER BY key').all(),
    rowsBeforeFailure,
  );
  assert.equal(fs.readFileSync(recoveryPath, 'utf8'), 'untouched-client-recovery');
  console.log(
    JSON.stringify({
      platform: process.platform,
      runtime: process.versions.electron ? 'Electron' : 'Node',
      checks: [
        'A-B-A credentials and idToken',
        'missing project cleared',
        'WAL online backup',
        'hot rewrite preserves first backup',
        'unrelated state preserved',
        'recovery file untouched',
        'primary write transaction rollback',
        ...(nativeWindows
          ? ['native Windows exact-target A-B-A, independent enumeration and nondestructive reads']
          : []),
      ],
      status: 'passed',
    }),
  );
} finally {
  database?.close();
  if (nativeWindows) {
    const library = require('koffi').load(
      path.win32.join(process.env.SystemRoot, 'System32', 'Advapi32.dll'),
    );
    try {
      library.func('int __stdcall CredDeleteW(str16 target, uint32_t type, uint32_t flags)')(
        credentialTarget,
        1,
        0,
      );
    } finally {
      library.unload();
    }
  }
  Module._resolveFilename = originalResolve;
  Module._load = originalLoad;
  assert(path.resolve(root).startsWith(base + path.sep));
  fs.rmSync(root, { recursive: true, force: true });
}
