import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import Module, { createRequire } from 'node:module';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import spawn from 'cross-spawn';
import { Command } from 'commander';
import { chromium } from 'playwright';
import { createCommand, connectBrowser } from './process-actions.mjs';
import { createCredentialReadback } from './credential-readback.mjs';
import { verifyClientIdentity } from './client-ui.mjs';
import { readOfficialSignedIn } from './official-auth-state.mjs';

const options = new Command()
  .requiredOption('--owner <owner>', 'cli or electron')
  .requiredOption('--runtime-root <path>', 'Runtime containing core, cli and native node_modules')
  .requiredOption(
    '--profile-home <path>',
    'Prepared isolated home containing two authorized accounts',
  )
  .requiredOption('--accounts-file <path>', 'JSON array containing the two account IDs')
  .requiredOption('--output <path>', 'Sanitized JSON report')
  .option(
    '--helpers <path>',
    'Compiled acceptance helpers',
    'out/account-switch-acceptance/helpers',
  )
  .option('--electron-bin <path>', 'Current Electron executable for the electron owner')
  .option('--electron-app <path>', 'Source application directory when using development Electron')
  .option('--attach-electron', 'Attach to the isolated Manager started with npm start', false)
  .option('--native-root <path>', 'ABI-compatible native libraries for the report process')
  .option('--target <target>', 'Only run one client: classic, ide or agy')
  .option(
    '--probe-cli',
    'Run a small real provider task through the official Antigravity CLI',
    false,
  )
  .option('--local-snapshots', 'Also verify A-B-A from local account snapshots', false)
  .option(
    '--complete-client-setup',
    'Complete explicitly authorized official first-run setup without interaction-data collection',
    false,
  )
  .option(
    '--keep-client-running',
    'Exercise switching and snapshots with the desktop client running',
    false,
  )
  .parse()
  .opts();
assert(['cli', 'electron'].includes(options.owner));
assert(!options.target || ['classic', 'ide', 'agy'].includes(options.target));
assert(options.owner !== 'electron' || options.electronBin || options.attachElectron);
const runtime = path.resolve(options.runtimeRoot);
const home = path.resolve(options.profileHome);
const helperDirectory = path.resolve(options.helpers);
const ids = JSON.parse(await fs.readFile(options.accountsFile, 'utf8'));
assert.equal(ids.length, 2);
const environment = {
  ...process.env,
  HOME: home,
  USERPROFILE: home,
  APPDATA: path.join(home, 'AppData/Roaming'),
  LOCALAPPDATA: path.join(home, 'AppData/Local'),
};
delete environment.ELECTRON_RUN_AS_NODE;
delete environment.NODE_PATH;
delete environment.NODE_OPTIONS;
Object.assign(process.env, environment);
const require = createRequire(import.meta.url);
const runtimeRequire = createRequire(path.join(runtime, 'package.json'));
const nativeRequire = options.nativeRoot
  ? createRequire(path.join(path.resolve(options.nativeRoot), 'package.json'))
  : runtimeRequire;
// Select the actual native libraries for this runtime, without substituting their behavior.
const resolved = new Map(
  ['better-sqlite3', 'keytar', 'koffi', '@napi-rs/keyring'].map((name) => [
    name,
    nativeRequire.resolve(name),
  ]),
);
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
  return resolved.get(request) ?? originalResolve.call(this, request, ...args);
};
const library = require(path.join(helperDirectory, 'runtime.cjs'));
const Database = nativeRequire('better-sqlite3');
const config = JSON.parse(
  await fs.readFile(path.join(home, '.antigravity-agent/gui_config.json'), 'utf8'),
);
const report = {
  version: 1,
  platform: process.platform,
  owner: options.owner,
  startedAt: new Date().toISOString(),
  results: [],
  cleanup: {},
};
const node = process.platform === 'win32' ? path.join(runtime, 'node/node.exe') : process.execPath;
const cli = path.join(
  runtime,
  runtime.endsWith('standalone') ? 'cli/main.cjs' : 'dist/cli/main.cjs',
);
const clients = new Map();
const desktopPort = process.platform === 'linux' ? 9430 : 9330;
const classicPort = process.platform === 'linux' ? 9441 : 9341;
const idePort = process.platform === 'linux' ? 9442 : 9342;
let desktop;
let desktopError;
let desktopBrowser;
let page;
let originalCredential;
let credentialCaptured = false;
let stage = 'startup';

const command = createCommand(environment);

async function connect(port) {
  return connectBrowser(port, () => (port === desktopPort ? desktopError : undefined));
}

async function invoke(name, input) {
  return page.evaluate(
    async ({ name, input }) => {
      const parts = name.split('.');
      let operation = window.accountAcceptance;
      for (const part of parts) {
        operation = operation[part];
      }
      return operation(input);
    },
    { name, input },
  );
}

async function switchAccount(id, target, source = 'cloud') {
  if (process.platform === 'linux' && target !== 'agy' && !options.keepClientRunning) {
    await closeTarget(target);
  }
  if (options.owner === 'cli') {
    await command(node, [cli, 'account', 'switch', id, '--target', target, '--source', source]);
  } else {
    await invoke(source === 'cloud' ? 'cloud.switchCloudAccount' : 'account.switchAccount', {
      accountId: id,
      appTarget: target,
    });
  }
}

async function closeTarget(target) {
  if (target === 'agy') {
    return;
  }
  const port = target === 'classic' ? classicPort : idePort;
  try {
    const browser =
      clients.get(target) ??
      (await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 1000 }));
    await browser
      .newBrowserCDPSession()
      .then((session) => session.send('Browser.close'))
      .catch(() => {});
    if (browser.isConnected()) {
      await Promise.race([browser.close().catch(() => {}), delay(3000)]);
    }
    clients.delete(target);
    await delay(1500);
  } catch {
    // The existing process guard still rejects unreadable or conflicting live clients.
  }
}

const { readTarget, expectedAccount } = createCredentialReadback({
  library,
  Database,
  config,
  home,
});

async function verify(target, id, alias, source, since) {
  stage = 'read-target-token';
  const token = await readTarget(target);
  const expected = await expectedAccount(id);
  assert(token?.accessToken && token.refreshToken);
  stage = 'compare-refresh-token';
  assert.equal(token.refreshToken, expected.token.refresh_token);
  stage = 'google-identity';
  const response = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
    headers: { Authorization: `Bearer ${token.accessToken}` },
    signal: AbortSignal.timeout(15000),
  });
  if (response.status !== 200) {
    const error = new Error('Google rejected the selected client session');
    error.code = `google-http-${response.status}`;
    throw error;
  }
  const profile = await response.json();
  assert.equal(profile.email.toLowerCase(), expected.email.toLowerCase());
  // A launched client can refresh its access token independently. Refresh-token ownership
  // and a live Google identity check establish the account without forbidding that refresh.
  const result = {
    target,
    source,
    account: alias,
    tokenReadback: true,
    accessTokenMatchesSaved: token.accessToken === expected.token.access_token,
    googleIdentity: true,
    identityHttpStatus: response.status,
  };
  if (process.platform === 'linux' && target !== 'agy') {
    result.switchMode = options.keepClientRunning
      ? 'client-running'
      : 'client-closed-before-switch';
  }
  if (target !== 'agy') {
    stage = 'client-window';
    const browser = await connect(target === 'classic' ? classicPort : idePort);
    clients.set(target, browser);
    Object.assign(
      result,
      await verifyClientIdentity(
        browser,
        expected.email,
        () => readOfficialSignedIn(home, target, since),
        { completeSetup: options.completeClientSetup },
      ),
    );
    if (!result.clientIdentityVisible && result.clientSignedIn) {
      result.clientVerification = 'official-auth-log-and-live-google';
    }
  } else if (options.probeCli) {
    stage = 'official-client-task';
    const executable = config.antigravity_cli_executable;
    const { stdout, bytes } = await command(
      executable,
      [
        '--print',
        'Reply with exactly ACCOUNT_SWITCH_OK. Do not use tools.',
        '--output-format',
        'json',
        '--print-timeout',
        '60s',
      ],
      75000,
    );
    result.clientTask = stdout.includes('ACCOUNT_SWITCH_OK');
    result.clientTaskOutputBytes = bytes;
    assert(result.clientTask, 'Official client did not complete the provider task');
  }
  return result;
}

try {
  if (process.platform === 'win32') {
    originalCredential = await library.readWindowsCredential('gemini:antigravity');
    credentialCaptured = true;
  }
  if (options.owner === 'cli') {
    await command(node, [cli, 'service', 'start']);
  } else {
    const args = [
      ...(options.electronApp ? [path.resolve(options.electronApp)] : []),
      `--user-data-dir=${path.join(home, 'desktop-data')}`,
      `--remote-debugging-port=${desktopPort}`,
      '--disable-gpu',
      ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
    ];
    if (!options.attachElectron) {
      const executable = path.resolve(options.electronBin);
      desktop = spawn(executable, args, {
        cwd: path.dirname(executable),
        env: environment,
        windowsHide: true,
        stdio: 'ignore',
      });
      desktop.on('error', (error) => {
        desktopError = error;
      });
      await once(desktop, 'spawn');
    }
    desktopBrowser = await connect(desktopPort);
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      page = desktopBrowser
        .contexts()
        .flatMap((context) => context.pages())
        .find(
          (candidate) =>
            candidate.url().startsWith('file:') || candidate.url().includes('localhost'),
        );
      if (page) {
        break;
      }
      await delay(500);
    }
    assert(page, 'Manager renderer did not open');
    await page.getByRole('main').waitFor({ timeout: 30000 });
    await page.evaluate(await fs.readFile(path.join(helperDirectory, 'renderer.js'), 'utf8'));
  }
  for (const target of options.target ? [options.target] : ['agy', 'classic', 'ide']) {
    const snapshots = [];
    for (const [index, alias] of [
      [0, 'A'],
      [1, 'B'],
      [0, 'A'],
    ]) {
      const started = Date.now();
      try {
        stage = 'switch';
        await switchAccount(ids[index], target);
        const result = await verify(target, ids[index], alias, 'cloud', started);
        if (options.localSnapshots && snapshots.length < 2) {
          stage = 'snapshot';
          if (process.platform === 'linux' && target !== 'agy' && !options.keepClientRunning) {
            // These official Linux clients overwrite argv, hiding their profile argument.
            // Collect after closing instead of relaxing the production directory guard.
            await closeTarget(target);
            result.snapshotCollection = 'client-closed';
          }
          const snapshot =
            options.owner === 'cli'
              ? JSON.parse(
                  (await command(node, [cli, 'account', 'snapshot', '--target', target])).stdout,
                )
              : await invoke('account.addAccountSnapshot', { appTarget: target });
          snapshots.push(snapshot.id);
        }
        const status = target !== 'agy' && !result.clientIdentityConfirmed ? 'partial' : 'passed';
        report.results.push({ ...result, elapsedMs: Date.now() - started, status });
        console.log(JSON.stringify({ target, source: 'cloud', account: alias, status }));
      } catch (error) {
        report.results.push({
          target,
          source: 'cloud',
          account: alias,
          status: 'failed',
          stage,
          errorKind: error.name,
          errorCode: error.code ?? null,
          clientPages: error.clientPages,
          clientFailures: error.clientFailures,
          failureCategories: error.failureCategories,
          elapsedMs: Date.now() - started,
        });
        console.log(
          JSON.stringify({
            target,
            source: 'cloud',
            account: alias,
            status: 'failed',
            stage,
            errorCode: error.code ?? null,
          }),
        );
        break;
      }
    }
    if (options.localSnapshots && snapshots.length === 2) {
      for (const [index, alias] of [
        [0, 'A'],
        [1, 'B'],
        [0, 'A'],
      ]) {
        try {
          const started = Date.now();
          await switchAccount(snapshots[index], target, 'local');
          const result = await verify(target, ids[index], alias, 'local', started);
          report.results.push({
            ...result,
            status: target !== 'agy' && !result.clientIdentityConfirmed ? 'partial' : 'passed',
          });
        } catch (error) {
          report.results.push({
            target,
            source: 'local',
            account: alias,
            status: 'failed',
            errorKind: error.name,
            errorCode: error.code ?? null,
          });
          break;
        }
      }
    }
    const browser = clients.get(target);
    if (browser) {
      await browser
        .newBrowserCDPSession()
        .then((session) => session.send('Browser.close'))
        .catch(() => {});
      if (browser.isConnected()) {
        await Promise.race([browser.close().catch(() => {}), delay(3000)]);
      }
      clients.delete(target);
      await delay(1500);
    }
  }
} catch (error) {
  report.failure = { stage, errorKind: error.name, errorCode: error.code ?? null };
} finally {
  if (options.owner === 'cli') {
    await command(node, [cli, 'service', 'stop']).then(
      () => {
        report.cleanup.ownerStopped = true;
      },
      () => {
        report.cleanup.ownerStopped = false;
      },
    );
  }
  for (const port of [classicPort, idePort]) {
    try {
      const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 1000 });
      await browser
        .newBrowserCDPSession()
        .then((session) => session.send('Browser.close'))
        .catch(() => {});
      if (browser.isConnected()) {
        await Promise.race([browser.close().catch(() => {}), delay(3000)]);
      }
    } catch {
      // Only close the clients launched with this acceptance run's debugging ports.
    }
  }
  if (desktopBrowser) {
    await desktopBrowser
      .newBrowserCDPSession()
      .then((session) => session.send('Browser.close'))
      .catch(() => {});
  }
  if (desktopBrowser?.isConnected()) {
    await Promise.race([desktopBrowser.close().catch(() => {}), delay(3000)]);
  }
  desktop?.kill();
  if (credentialCaptured) {
    if (originalCredential !== null) {
      await library.writeWindowsCredential('gemini:antigravity', 'antigravity', originalCredential);
    } else {
      runtimeRequire('@napi-rs/keyring')
        .Entry.withTarget('gemini:antigravity', 'gemini', 'antigravity')
        .deleteCredential();
    }
    report.cleanup.originalCredentialRestored =
      (await library.readWindowsCredential('gemini:antigravity')) === originalCredential;
  }
  report.finishedAt = new Date().toISOString();
  report.status =
    report.failure ||
    report.results.some((result) => result.status === 'failed') ||
    !report.results.length
      ? 'failed'
      : report.results.some((result) => result.status === 'partial')
        ? 'partial'
        : 'passed';
  await fs.mkdir(path.dirname(path.resolve(options.output)), { recursive: true });
  await fs.writeFile(options.output, JSON.stringify(report, null, 2) + '\n');
  console.log(
    JSON.stringify({
      status: report.status,
      checks: report.results.length,
      output: path.resolve(options.output),
    }),
  );
  process.exitCode = report.status === 'passed' ? 0 : 1;
}
