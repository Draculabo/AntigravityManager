// Dedicated native fixtures exercise service respawn without touching an installed IDE.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawn } from 'node:child_process';
import ts from 'typescript';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtureBase = fs.realpathSync.native(os.tmpdir());
const directory = fs.mkdtempSync(path.join(fixtureBase, 'agm-hot-fixture-'));
assert(path.resolve(directory).startsWith(path.resolve(fixtureBase) + path.sep));
const windows = process.platform === 'win32';
const executable = path.join(directory, windows ? 'Antigravity IDE.exe' : 'antigravity-ide');
const serviceExecutable = path.join(directory, `language_server_fixture${windows ? '.exe' : ''}`);
const terminalExecutable = path.join(directory, `terminal_fixture${windows ? '.exe' : ''}`);
const fixture = path.join(directory, 'fixture.cjs');
const credentials = path.join(directory, 'credentials.json');
const ready = path.join(directory, 'ready.json');
const heartbeat = path.join(directory, 'terminal.txt');
let child;
let read;

function compile(source, name) {
  let code = ts.transpileModule(fs.readFileSync(path.join(repo, source), 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  }).outputText;
  for (const [original, replacement] of Object.entries({
    '@/shared/platform/paths': './paths.cjs',
    '@/shared/platform/nativeProcessQuery': './query.cjs',
    '@/shared/platform/antigravityAppTarget': './target.cjs',
    '@/shared/logging/logger': './logger.cjs',
    '@/shared/errors/appError': './app-error.cjs',
  })) {
    code = code.replaceAll(JSON.stringify(original), JSON.stringify(replacement));
  }
  code = code.replace(/require\("\.\/([A-Za-z]+)"\)/g, 'require("./$1.cjs")');
  fs.writeFileSync(
    path.join(directory, `${name}.cjs`),
    `module.paths.push(${JSON.stringify(path.join(repo, 'node_modules'))});\n${code}`,
  );
}

async function waitFor(check, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Fixture did not reach the expected state');
}

try {
  for (const destination of [executable, serviceExecutable, terminalExecutable]) {
    fs.copyFileSync(process.execPath, destination);
    if (!windows) {
      fs.chmodSync(destination, 0o755);
    }
  }
  fs.writeFileSync(credentials, JSON.stringify({ account: 'fixture-A' }));
  fs.writeFileSync(
    fixture,
    `
const fs = require('node:fs');
const path = require('node:path');
const {spawn} = require('node:child_process');
const base = __dirname;
const role = process.argv[2];
const service = ${JSON.stringify(serviceExecutable)};
const terminal = ${JSON.stringify(terminalExecutable)};
setTimeout(() => process.exit(), 60000);
function ai() {
  const child = spawn(service, [__filename, 'service'], {stdio:'ignore'});
  child.once('exit', () => setTimeout(ai, 50));
}
if (role === 'service') {
  const account = JSON.parse(fs.readFileSync(path.join(base,'credentials.json'),'utf8')).account;
  fs.writeFileSync(path.join(base, 'service-'+process.pid+'.json'), JSON.stringify({pid:process.pid,account}));
} else if (role === 'terminal') {
  let count = 0;
  setInterval(() => fs.writeFileSync(path.join(base,'terminal.txt'), String(++count)), 50);
} else if (role === 'host') {
  ai();
} else {
  // This value lives only in the root process and must survive every hot switch.
  const workspace = {nonce: require('node:crypto').randomUUID(), unsavedBuffer:'fixture edits'};
  const host = spawn(process.execPath,[__filename,'host','--type=utility'],{stdio:'ignore'});
  const task = spawn(terminal,[__filename,'terminal'],{stdio:'ignore'});
  ai();
  fs.writeFileSync(path.join(base,'ready.json'),JSON.stringify({pid:process.pid,hostPid:host.pid,terminalPid:task.pid,workspace}));
  setInterval(() => fs.writeFileSync(path.join(base,'workspace.json'),JSON.stringify(workspace)),50);
}
`,
  );

  for (const name of [
    'ideHotSwitch',
    'launchContext',
    'processObserver',
    'windowsInterop',
    'processErrors',
    'runtimePlatform',
  ]) {
    compile(`src/modules/antigravity-runtime/${name}.ts`, name);
  }
  compile('src/shared/platform/antigravityAppTarget.ts', 'target');
  compile('src/shared/platform/nativeProcessQuery.ts', 'native-query');
  compile('src/shared/errors/appError.ts', 'app-error');
  // Queries and process discovery are restricted to binaries created by this check.
  fs.writeFileSync(
    path.join(directory, 'query.cjs'),
    `
const {readNativeProcessSnapshot} = require('./native-query.cjs');
exports.readNativeProcessSnapshot = async timeout => (await readNativeProcessSnapshot(timeout))
  .filter(row => row.exe && require('node:path').dirname(row.exe) === ${JSON.stringify(directory)});
`,
  );
  fs.writeFileSync(
    path.join(directory, 'logger.cjs'),
    'exports.logger={info(){},warn(...args){console.error(...args)}};',
  );
  fs.writeFileSync(
    path.join(directory, 'paths.cjs'),
    `
exports.isWsl=()=>false;
exports.getConfiguredAntigravityExecutablePath=()=>${JSON.stringify(executable)};
exports.getAntigravityExecutablePath=()=>${JSON.stringify(executable)};
exports.getConfiguredAntigravityArgs=()=>[];
exports.getPortableUserDataDir=()=>null;
exports.getAppDataDir=()=>${JSON.stringify(directory)};
exports.areExecutablePathsEquivalent=(a,b)=>a===b;
exports.isTargetAntigravityProcessCandidate=p=>p.executablePath===${JSON.stringify(executable)};
exports.isConfiguredTargetExecutableProcessCandidate=exports.isTargetAntigravityProcessCandidate;
`,
  );
  const require = createRequire(path.join(directory, 'entry.cjs'));
  const { prepareIdeHotSwitch } = require('./ideHotSwitch.cjs');
  const { observeProcesses } = require('./processObserver.cjs');
  read = require('./query.cjs').readNativeProcessSnapshot;
  await read();
  child = spawn(executable, [fixture, 'main'], { stdio: 'ignore' });
  await waitFor(
    async () =>
      fs.existsSync(ready) &&
      fs.existsSync(heartbeat) &&
      (await read()).filter((row) => row.exe === serviceExecutable).length === 2,
  );
  const original = JSON.parse(fs.readFileSync(ready, 'utf8'));
  const originalProcesses = await observeProcesses('ide', 1000, executable);
  assert.equal(originalProcesses.length, 1);
  assert.equal(originalProcesses[0].pid, original.pid);
  const context = {
    target: 'ide',
    executablePath: executable,
    args: [fixture, 'main'],
    defaultUserDataDir: directory,
    pathOptions: { userDataDir: directory },
    processes: originalProcesses,
  };
  const cycles = [];
  for (const account of ['fixture-B', 'fixture-A', 'fixture-B']) {
    const before = await read();
    const oldServices = before.filter((row) => row.exe === serviceExecutable);
    const session = await prepareIdeHotSwitch(context);
    assert(session, 'The native service tree must be eligible for hot switching');
    const tick = Number(fs.readFileSync(heartbeat, 'utf8'));
    const started = Date.now();
    fs.writeFileSync(credentials, JSON.stringify({ account }));
    assert.equal(await session.stopServices(), true);
    fs.writeFileSync(credentials, JSON.stringify({ account }));
    assert.equal(await session.confirmReplacement(), true);
    const hotSwitchMs = Date.now() - started;
    const after = await read();
    const services = after.filter((row) => row.exe === serviceExecutable);
    assert.equal(services.length, 2);
    assert(
      !services.some((row) =>
        oldServices.some((old) => old.pid === row.pid && old.startTime === row.startTime),
      ),
    );
    assert(after.some((row) => row.pid === original.terminalPid && row.exe === terminalExecutable));
    assert.deepEqual(await observeProcesses('ide', 1000, executable), originalProcesses);
    await waitFor(() =>
      services.every((row) => fs.existsSync(path.join(directory, `service-${row.pid}.json`))),
    );
    assert.deepEqual(
      services.map(
        (row) =>
          JSON.parse(fs.readFileSync(path.join(directory, `service-${row.pid}.json`), 'utf8'))
            .account,
      ),
      [account, account],
    );
    await waitFor(() => Number(fs.readFileSync(heartbeat, 'utf8')) > tick);
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(directory, 'workspace.json'), 'utf8')),
      original.workspace,
    );
    cycles.push({ hotSwitchMs, replacedServices: services.length });
  }
  console.log(
    JSON.stringify({
      platform: process.platform,
      cycles,
      mainIdentityPreserved: true,
      terminalPreserved: true,
      inMemoryWorkspacePreserved: true,
      replacementCredentials: 'passed',
    }),
  );
} finally {
  const rows = read ? await read().catch(() => []) : [];
  if (child && !rows.some((row) => row.pid === child.pid)) {
    child.kill('SIGKILL');
  }
  // Only verified binaries inside this generated directory can be terminated or removed.
  for (const row of rows) {
    try {
      if (windows) {
        execFileSync('taskkill.exe', ['/PID', String(row.pid), '/F'], {
          timeout: 5000,
          stdio: 'ignore',
        });
      } else {
        process.kill(row.pid, 'SIGKILL');
      }
    } catch {
      // Another fixture process may have exited during cleanup.
    }
  }
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert(path.resolve(directory).startsWith(path.resolve(fixtureBase) + path.sep));
  fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
