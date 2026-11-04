import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module, { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { execFile, spawn } from 'node:child_process';

const { values } = parseArgs({
  options: {
    helpers: { type: 'string', default: 'out/account-switch-acceptance/helpers' },
    'native-root': { type: 'string', default: '.' },
    output: { type: 'string' },
    child: { type: 'boolean', default: false },
  },
});
assert.equal(process.platform, 'linux', 'This check requires Linux Secret Service');
const runFile = promisify(execFile);

if (!values.child) {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'agm-linux-credentials-'));
  fs.chmodSync(fixture, 0o700);
  fs.mkdirSync(path.join(fixture, 'runtime'), { mode: 0o700 });
  const environment = {
    ...process.env,
    HOME: fixture,
    USERPROFILE: fixture,
    XDG_CONFIG_HOME: path.join(fixture, '.config'),
    XDG_DATA_HOME: path.join(fixture, '.local/share'),
    XDG_CACHE_HOME: path.join(fixture, '.cache'),
    XDG_RUNTIME_DIR: path.join(fixture, 'runtime'),
  };
  for (const key of [
    'NODE_OPTIONS',
    'ELECTRON_RUN_AS_NODE',
    'GNOME_KEYRING_CONTROL',
    'GNOME_KEYRING_PID',
  ]) {
    delete environment[key];
  }
  try {
    const output = await new Promise((resolve, reject) => {
      const child = spawn(
        'dbus-run-session',
        [
          '--',
          process.execPath,
          fileURLToPath(import.meta.url),
          '--child',
          '--helpers',
          path.resolve(values.helpers),
          '--native-root',
          path.resolve(values['native-root']),
        ],
        { env: environment, detached: true, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      let stdout = '';
      let size = 0;
      const stop = () => {
        if (child.pid) {
          try {
            process.kill(-child.pid, 'SIGKILL');
          } catch (error) {
            if (error.code !== 'ESRCH') {
              throw error;
            }
          }
        }
      };
      const timer = setTimeout(stop, 60000);
      for (const stream of [child.stdout, child.stderr]) {
        stream.on('data', (chunk) => {
          size += chunk.length;
          if (size > 128 * 1024) {
            stop();
          }
          if (stream === child.stdout) {
            stdout += chunk.toString();
          }
        });
      }
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once('close', (code) => {
        clearTimeout(timer);
        const line = stdout.trim().split('\n').at(-1);
        let report;
        try {
          report = JSON.parse(line);
        } catch {
          reject(new Error('Linux native fixture returned no report'));
          return;
        }
        if (values.output) {
          fs.writeFileSync(values.output, `${JSON.stringify(report, null, 2)}\n`);
        }
        if (code !== 0 || report.status !== 'passed') {
          reject(new Error('Linux native credential fixture failed'));
          return;
        }
        resolve(report);
      });
    });
    console.log(JSON.stringify(output));
  } finally {
    assert.equal(path.dirname(fixture), os.tmpdir());
    assert.equal(fs.realpathSync(fixture), fixture);
    fs.rmSync(fixture, { recursive: true, force: true });
  }
} else {
  const home = process.env.HOME;
  assert(home && path.basename(home).startsWith('agm-linux-credentials-'));
  assert(process.env.DBUS_SESSION_BUS_ADDRESS);
  const native = createRequire(path.join(path.resolve(values['native-root']), 'package.json'));
  const resolveOriginal = Module._resolveFilename;
  const libraries = new Map(
    ['better-sqlite3', 'keytar', 'koffi', '@napi-rs/keyring'].map((name) => [
      name,
      native.resolve(name),
    ]),
  );
  Module._resolveFilename = function (name, ...args) {
    return resolveOriginal.call(this, libraries.get(name) ?? name, ...args);
  };
  const require = createRequire(import.meta.url);
  const runtime = require(path.join(path.resolve(values.helpers), 'runtime.cjs'));
  const report = { checks: [], status: 'failed' };
  const log = fs.openSync(path.join(home, 'keyring.log'), 'wx', 0o600);
  const daemon = spawn(
    'gnome-keyring-daemon',
    [
      '--foreground',
      '--components=secrets',
      `--control-directory=${path.join(home, 'runtime/keyring')}`,
      '--unlock',
    ],
    { stdio: ['pipe', log, log] },
  );
  fs.closeSync(log);
  daemon.on('error', () => {});
  const exited = new Promise((resolve) => daemon.once('close', resolve));
  daemon.stdin.on('error', () => {});
  daemon.stdin.end('disposable-native-verification-only\n');
  let mutated = false;
  try {
    // WSL otherwise defaults to discovering Windows installations. This fixture owns Linux state.
    fs.mkdirSync(path.join(home, '.antigravity-agent'), { recursive: true });
    fs.writeFileSync(
      path.join(home, '.antigravity-agent/gui_config.json'),
      JSON.stringify({
        antigravity_executable: '/opt/agm-native-fixture/antigravity',
        antigravity_ide_executable: '/opt/agm-native-fixture/antigravity-ide',
      }),
    );
    await runFile('gdbus', ['wait', '--session', 'org.freedesktop.secrets'], {
      timeout: 10000,
      maxBuffer: 4096,
    });
    const keytar = native('keytar');
    await keytar.setPassword('agm-fixture-readiness', 'fixture', 'synthetic');
    await keytar.deletePassword('agm-fixture-readiness', 'fixture');
    assert.deepEqual(await runtime.readLinuxIdeCredentialSnapshot(), []);
    mutated = true;
    await runtime.writeLinuxIdeCredentialPayload('synthetic-default');
    await seedSessionCollection(native);
    const before = await runtime.readLinuxIdeCredentialSnapshot();
    assert.equal(before.length, 2);
    const database = path.join(home, 'client-ide/User/globalStorage/state.vscdb');
    fs.mkdirSync(path.dirname(database), { recursive: true });
    fs.writeFileSync(database, 'recovery-path-fixture');
    const standalone = path.join(home, '.gemini/jetski-standalone-oauth-token');
    fs.mkdirSync(path.dirname(standalone));
    const original = Buffer.from('synthetic-file\0\xff', 'latin1');
    fs.writeFileSync(standalone, original, { mode: 0o600 });
    await (
      await runtime.prepareLinuxIdeRecovery(database)
    )();
    const recovery = JSON.parse(
      fs.readFileSync(`${database}.account-switch.linux-credentials.backup`, 'utf8'),
    );
    assert.deepEqual(recovery, {
      version: 1,
      standalonePath: standalone,
      credentials: before,
      standalone: { bytes: original.toString('base64'), mode: 0o600 },
    });
    await runtime.writeLinuxIdeCredentialPayload('synthetic-replacement');
    assert(
      (await runtime.readLinuxIdeCredentialSnapshot()).every(
        (item) => Buffer.from(item.payload, 'base64').toString() === 'synthetic-replacement',
      ),
    );
    report.checks.push('all-collections-updated');
    fs.writeFileSync(standalone, 'replacement-file');
    await runtime.restoreLinuxIdeCredentials({ userDataDir: path.join(home, 'client-ide') });
    assert.deepEqual(await runtime.readLinuxIdeCredentialSnapshot(), before);
    assert.deepEqual(fs.readFileSync(standalone), original);
    report.checks.push('json-recovery-api-exact-native-and-file');
    await assert.rejects(
      runtime.restoreLinuxIdeCredentialSnapshot([
        ...before,
        { ...before[0], path: '/org/freedesktop/secrets/collection/missing/999' },
      ]),
    );
    assert.deepEqual(await runtime.readLinuxIdeCredentialSnapshot(), before);
    report.checks.push('missing-original-item-refused-before-mutation');
    await runtime.restoreLinuxIdeCredentialSnapshot([]);
    assert.deepEqual(await runtime.readLinuxIdeCredentialSnapshot(), []);
    report.checks.push('absent-native-items-restored');
    report.status = 'passed';
  } catch (error) {
    report.errorKind = error.name;
    report.errorMessage = error.message;
    process.exitCode = 1;
  } finally {
    if (mutated) {
      try {
        await runtime.restoreLinuxIdeCredentialSnapshot([]);
      } catch {
        report.status = 'failed';
        report.cleanupFailed = true;
        process.exitCode = 1;
      }
    }
    daemon.kill('SIGTERM');
    const timer = setTimeout(() => daemon.kill('SIGKILL'), 2000);
    await exited;
    clearTimeout(timer);
    report.keyringStopped = true;
    console.log(JSON.stringify(report));
  }
}

/** Independent fixture creation uses libsecret's password API in the unlocked session collection. */
async function seedSessionCollection(native) {
  const koffi = native('koffi');
  const secret = koffi.load('libsecret-1.so.0');
  const glib = koffi.load('libglib-2.0.so.0');
  const attributes = glib.func('void *g_hash_table_new(void *hash, void *equal)')(
    glib.symbol('g_str_hash', 'uint8_t'),
    glib.symbol('g_str_equal', 'uint8_t'),
  );
  const strings = ['service', 'gemini', 'username', 'antigravity'].map((value) =>
    Buffer.from(`${value}\0`),
  );
  const insert = glib.func('int g_hash_table_insert(void *table, void *key, void *value)');
  insert(attributes, strings[0], strings[1]);
  insert(attributes, strings[2], strings[3]);
  try {
    const store = secret.func(
      'int secret_password_storev_sync(void *schema, void *attributes, str collection, str label, str password, void *cancel, _Out_ void **error)',
    );
    const error = [null];
    const ok = await new Promise((resolve, reject) =>
      store.async(
        null,
        attributes,
        '/org/freedesktop/secrets/collection/session',
        'synthetic-session-item',
        'synthetic-session',
        null,
        error,
        (failure, value) => (failure ? reject(failure) : resolve(value)),
      ),
    );
    assert.equal(ok, 1);
    assert.equal(error[0], null);
  } finally {
    glib.func('void g_hash_table_unref(void *table)')(attributes);
  }
}
