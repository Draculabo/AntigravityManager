import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { build, loadConfigFromFile } from 'vite';
import { c as archiveTar, x as extractTar } from 'tar';
import { pipeline } from 'node:stream/promises';

const project = process.cwd();
assert(
  process.argv.length === 3 || (process.argv.length === 4 && process.argv[3] === '--capacity'),
  'Supply the packaged standalone resource directory and optional --capacity',
);
const capacity = process.argv[3] === '--capacity';
const source = path.resolve(process.argv[2]);
const manifest = JSON.parse(await readFile(path.join(source, 'runtime-manifest.json'), 'utf8'));
assert.equal(manifest.version, 1);
assert.equal(manifest.platform, process.platform);
assert.equal(manifest.arch, process.arch);
const temporaryParent = await realpath(os.tmpdir());
const directory = await mkdtemp(path.join(temporaryParent, 'agm-installed-runtime-'));
const root = path.join(directory, 'standalone');
const home = path.join(directory, 'home');
const service = `AntigravityManager-Acceptance-${randomUUID()}`;
const environment = {
  ...process.env,
  USERPROFILE: home,
  HOME: home,
  APPDATA: path.join(home, 'AppData', 'Roaming'),
  LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
  AGM_DIAGNOSTIC_TEST_HOME: home,
  AGM_DIAGNOSTIC_TEST_CRASH: '1',
};
delete environment.NODE_PATH;
delete environment.NODE_OPTIONS;
if (capacity) {
  environment.AGM_DIAGNOSTIC_TEST_LARGE_THOUGHT = '1';
}
const executable = path.join(root, 'node', process.platform === 'win32' ? 'node.exe' : 'node');
let credentialsTouched = false;
async function verifyFile(file, expected) {
  assert.equal(typeof expected, 'string');
  assert.match(expected, /^[a-f0-9]{64}$/);
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(file)) {
    digest.update(chunk);
  }
  assert.equal(digest.digest('hex'), expected, 'Installed resource manifest mismatch');
}
function run(args, timeout = 60_000) {
  const child = spawnSync(executable, args, {
    cwd: root,
    env: environment,
    encoding: 'utf8',
    windowsHide: true,
    timeout,
    maxBuffer: 12_000,
  });
  if (child.error) {
    process.stdout.write(child.stdout ?? '');
    process.stderr.write(child.stderr ?? '');
    throw child.error;
  }
  if (child.status !== 0) {
    process.stdout.write((child.stdout ?? '').slice(-4000));
  }
  assert.equal(
    child.status,
    0,
    `Installed runtime check failed: ${(child.stderr ?? '').slice(-4000)}`,
  );
  return child.stdout ?? '';
}

// All credentials are synthetic and uniquely scoped. No production service is read or changed.
const credentialCheck = `
const assert = require('node:assert/strict');
const keytar = require('keytar');
const keyring = require('@napi-rs/keyring');
const crypto = require('node:crypto');
const service = process.argv[1];
const phase = process.argv[2];
const value = (version) => crypto.createHash('sha256').update(service + version).digest('hex');
const entry = new keyring.Entry(service, 'native-probe');
(async () => {
  if (phase === 'create') {
    assert.equal(await keytar.getPassword(service, 'probe'), null);
    await keytar.setPassword(service, 'probe', value('1'));
    assert.equal(entry.getPassword(), null);
    entry.setPassword(value('1'));
  } else if (phase === 'reopen') {
    assert.equal(await keytar.getPassword(service, 'probe'), value('1'));
    await keytar.setPassword(service, 'probe', value('2'));
    assert.equal(await keytar.getPassword(service, 'probe'), value('2'));
    assert.equal(await keytar.deletePassword(service, 'probe'), true);
    assert.equal(await keytar.getPassword(service, 'probe'), null);
    assert.equal(entry.getPassword(), value('1'));
    entry.setPassword(value('2'));
    assert.equal(entry.getPassword(), value('2'));
    assert.equal(entry.deleteCredential(), true);
    assert.equal(entry.getPassword(), null);
  } else if (phase === 'core') {
    const key = await keytar.getPassword(service, 'MasterKeyV2');
    assert(key && /^[a-f0-9]{64}$/i.test(key), 'Core did not persist its synthetic master key');
  } else {
    entry.deleteCredential();
    new keyring.Entry(service, 'opencode-proxy-key').deleteCredential();
    for (const item of await keytar.findCredentials(service)) {
      await keytar.deletePassword(service, item.account);
    }
    assert.deepEqual(await keytar.findCredentials(service), []);
  }
})().catch(() => { console.error('Synthetic OS credential acceptance failed'); process.exitCode = 1; });
`;

try {
  console.log('Copying packaged resources into an isolated installation.');
  await mkdir(root);
  await pipeline(archiveTar({ cwd: source }, ['.']), extractTar({ cwd: root }));
  for (const [file, expected] of [
    [executable, manifest.nodeExecutableSha256],
    [path.join(root, 'package-lock.json'), manifest.lockSha256],
    [path.join(root, 'core', 'main.cjs'), manifest.coreSha256],
    [path.join(root, 'cli', 'main.cjs'), manifest.cliSha256],
    [path.join(root, 'core', 'traffic-audit.worker.js'), manifest.auditWorkerSha256],
    [path.join(root, 'core', 'thought-store.worker.js'), manifest.thoughtWorkerSha256],
  ]) {
    await verifyFile(file, expected);
  }
  await mkdir(home);
  for (const file of ['main.cjs', 'traffic-audit.worker.js', 'thought-store.worker.js']) {
    assert(
      (await stat(path.join(root, 'core', file))).isFile(),
      `Missing required core entry: ${file}`,
    );
  }
  run([
    '-e',
    "const assert=require('node:assert/strict'); assert.equal(require('node:os').homedir(),process.argv[1]); const D=require('better-sqlite3'); const db=new D('acceptance.sqlite'); db.pragma('journal_mode = WAL'); db.exec('CREATE TABLE fixture(value INTEGER)'); db.prepare('INSERT INTO fixture VALUES (?)').run(7); db.close(); const reopened=new D('acceptance.sqlite'); assert.equal(reopened.prepare('SELECT value FROM fixture').get().value,7); assert.equal(reopened.pragma('journal_mode',{simple:true}),'wal'); reopened.close();",
    home,
  ]);
  credentialsTouched = true;
  run(['-e', credentialCheck, service, 'create']);
  run(['-e', credentialCheck, service, 'reopen']);
  console.log('Installed SQLite WAL/reopen and real OS credential CRUD/restart passed.');

  const core = path.join(root, 'core');
  const loaded = await loadConfigFromFile(
    { command: 'build', mode: 'production' },
    path.join(project, 'vite.core.config.mts'),
  );
  assert(loaded);
  await build({
    ...loaded.config,
    configFile: false,
    plugins: [],
    logLevel: 'error',
    // Presentation-only JS belongs to this harness, not the standalone production graph.
    ssr: {
      noExternal: [/^@orpc\//],
      external: [...loaded.config.build.rollupOptions.external, 'electron', 'electron/main'],
    },
    build: {
      ...loaded.config.build,
      outDir: core,
      emptyOutDir: false,
      sourcemap: false,
      rollupOptions: {
        ...loaded.config.build.rollupOptions,
        external: [...loaded.config.build.rollupOptions.external, 'electron', 'electron/main'],
        input: path.join(project, 'scripts/acceptance/runtime/core-bootstrap-native-entry.ts'),
        output: {
          format: 'cjs',
          entryFileNames: 'bootstrap.cjs',
          chunkFileNames: 'acceptance-[name]-[hash].cjs',
        },
      },
    },
  });
  const electron = path.join(core, 'node_modules', 'electron');
  await mkdir(electron, { recursive: true });
  await writeFile(path.join(electron, 'package.json'), JSON.stringify({ main: 'index.cjs' }));
  await writeFile(
    path.join(electron, 'index.cjs'),
    'throw new Error("Electron API touched by Node composition acceptance");\n',
  );
  const homePreload = path.join(core, 'isolated-home.cjs');
  await writeFile(homePreload, `require('node:os').homedir = () => ${JSON.stringify(home)};\n`);
  if (capacity) {
    await build({
      ...loaded.config,
      configFile: false,
      plugins: [],
      logLevel: 'error',
      build: {
        ...loaded.config.build,
        outDir: core,
        emptyOutDir: false,
        sourcemap: false,
        rollupOptions: {
          ...loaded.config.build.rollupOptions,
          input: path.join(project, 'scripts/acceptance/runtime/installed-thought-native-entry.ts'),
          output: {
            format: 'cjs',
            entryFileNames: 'seed-thought.cjs',
            chunkFileNames: 'seed-[name]-[hash].cjs',
          },
        },
      },
    });
    process.stdout.write(run(['--require', homePreload, path.join(core, 'seed-thought.cjs')]));
  }
  const keyringPreload = path.join(core, 'isolated-keyring.cjs');
  await writeFile(
    keyringPreload,
    `
const keytar = require('keytar');
for (const method of ['getPassword', 'setPassword', 'deletePassword', 'findCredentials']) {
  const actual = keytar[method].bind(keytar);
  keytar[method] = (requestedService, ...args) => {
    if (requestedService !== 'AntigravityManager') { throw new Error('Unexpected credential service'); }
    return actual(${JSON.stringify(service)}, ...args);
  };
}
const keyring = require('@napi-rs/keyring');
const ActualEntry = keyring.Entry;
keyring.Entry = class {
  constructor(requestedService, account) {
    if (requestedService !== 'Antigravity Manager') { throw new Error('Unexpected keyring service'); }
    return new ActualEntry(${JSON.stringify(service)}, account);
  }
};
process.on('exit', () => require('node:fs').writeFileSync(require('node:path').join(${JSON.stringify(directory)}, 'rss-' + process.pid + '.json'), JSON.stringify({ pid: process.pid, peakRssKiB: process.resourceUsage().maxRSS })));
`,
  );
  await writeFile(
    path.join(core, 'isolated-core.cjs'),
    `require(${JSON.stringify(homePreload)}); require(${JSON.stringify(keyringPreload)}); process.execArgv.push('--require', ${JSON.stringify(homePreload)}); require('./main.cjs');\n`,
  );
  const presentationPreload = path.join(core, 'presentation-only.cjs');
  await writeFile(
    presentationPreload,
    `
require(${JSON.stringify(homePreload)});
let ownerLocalTouched = false;
const forbidden = () => { ownerLocalTouched = true; throw new Error('Presentation opened owner-local native state'); };
process.on('exit', () => { if (ownerLocalTouched) { process.exitCode = 1; } });
require('better-sqlite3');
require.cache[require.resolve('better-sqlite3')].exports = forbidden;
require('keytar');
require.cache[require.resolve('keytar')].exports = { getPassword: forbidden, setPassword: forbidden, findCredentials: forbidden, deletePassword: forbidden };
require('node:worker_threads').Worker = forbidden;
require('@napi-rs/keyring').Entry = class { constructor() { forbidden(); } };
`,
  );
  // Four bounded cold starts and three terminal drains need a whole-run budget above 60 seconds.
  console.log(
    run(['--require', presentationPreload, path.join(core, 'bootstrap.cjs')], 180_000).trim(),
  );
  run(['-e', credentialCheck, service, 'core']);
  const metrics = [];
  for (const file of await readdir(directory)) {
    if (/^rss-\d+\.json$/.test(file)) {
      metrics.push(JSON.parse(await readFile(path.join(directory, file), 'utf8')));
    }
  }
  assert.equal(metrics.length, 3);
  console.log(
    `Core process peak RSS KiB (${capacity ? 'near-limit Thought reads/audit activity' : 'empty profile/audit activity'}): ${metrics.map((metric) => metric.peakRssKiB).join(', ')}`,
  );
  console.log(
    'Packaged standalone resource acceptance passed outside the repository; Electron UI and installer execution remain separate gates.',
  );
} catch (error) {
  const profile = path.join(home, '.antigravity-agent');
  for (const file of await readdir(profile).catch(() => [])) {
    if (/^core-.*\.log$/.test(file)) {
      const content = await readFile(path.join(profile, file), 'utf8');
      process.stderr.write(content.slice(-4000));
    }
  }
  throw error;
} finally {
  try {
    if (credentialsTouched) {
      run(['-e', credentialCheck, service, 'cleanup']);
    }
  } finally {
    assert.equal(path.dirname(await realpath(directory)), temporaryParent);
    assert(path.basename(directory).startsWith('agm-installed-runtime-'));
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}
