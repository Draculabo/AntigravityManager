import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createReadStream, existsSync } from 'node:fs';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { chromium } from 'playwright';
import { extractFile, uncache } from '@electron/asar';
import YAML from 'yaml';
import { loginSettings } from '../helpers/windows-login-settings.mjs';
import { squirrelRegistration } from '../helpers/windows-squirrel-registration.mjs';
import { listNsisAttemptLogs, readNsisAttempt } from './nsis-attempt-log.mjs';
import { installedAppWindowReady, stopFixtureApps } from './nsis-app-processes.mjs';

const preparationStages = ['check-environment', 'prepare-files', 'extract-files', 'verify-files'];
const installationStages = [
  ...preparationStages,
  'activate-version',
  'cache-installer',
  'register-installation',
  'clean-up',
];

assert.equal(process.platform, 'win32');
assert.equal(process.arch, 'x64');
assert(
  process.argv.length === 5 || process.argv.length === 6,
  'Supply previous NSIS installer, current installer, current metadata and optional incomplete installer',
);
const project = await realpath(process.cwd());
const outRoot = await realpath(path.join(project, 'out'));
const previousInstaller = await realpath(path.resolve(process.argv[2]));
const currentInstaller = await realpath(path.resolve(process.argv[3]));
const metadataFile = await realpath(path.resolve(process.argv[4]));
const incompleteInstaller = process.argv[5] && (await realpath(path.resolve(process.argv[5])));
for (const file of [previousInstaller, currentInstaller, metadataFile, incompleteInstaller].filter(
  Boolean,
)) {
  assert(file.startsWith(`${outRoot}${path.sep}`));
}
if (incompleteInstaller) {
  assert.notEqual(incompleteInstaller, previousInstaller);
  assert.notEqual(incompleteInstaller, currentInstaller);
}
const metadata = YAML.parse(await readFile(metadataFile, 'utf8'));
assert.equal(metadata.files?.[0]?.url, path.basename(currentInstaller));
const currentVersion = metadata.version;
const defaultUserData = path.join(process.env.APPDATA, 'Antigravity Manager');
assert(
  !existsSync(defaultUserData),
  'Run installed NSIS acceptance from a disposable Windows account with no existing app profile',
);
const temporaryParent = await realpath(os.tmpdir());
const directory = await mkdtemp(path.join(temporaryParent, 'agm-nsis-update-'));
const requestedInstall = path.join(directory, 'install');
const defaultInstall = path.join(process.env.LOCALAPPDATA, 'Programs', 'antigravity-manager');
assert(
  !existsSync(defaultInstall),
  `Existing NSIS installation must not be changed: ${defaultInstall}`,
);
const profile = path.join(directory, 'profile');
const diagnosticDirectory = path.join(profile, '.antigravity-agent');
const userData = path.join(profile, 'desktop-data');
const marker = path.join(userData, 'retained-marker.txt');
const loginBackup = path.join(directory, 'login-settings.json');
const squirrelRegistryBackup = path.join(directory, 'squirrel-registration.json');
const environment = {
  ...process.env,
  HOME: profile,
  USERPROFILE: profile,
  APPDATA: path.join(profile, 'AppData', 'Roaming'),
  LOCALAPPDATA: path.join(profile, 'AppData', 'Local'),
  AGM_UPDATE_ALLOW_UNMANAGED: '1',
};
const profileDefaultInstall = path.join(
  environment.LOCALAPPDATA,
  'Programs',
  'antigravity-manager',
);
const installRoots = [requestedInstall, profileDefaultInstall, defaultInstall];
delete environment.NODE_OPTIONS;
delete environment.NODE_PATH;
delete environment.ELECTRON_RUN_AS_NODE;

async function until(check, timeout = 60_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) {
      return result;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('NSIS updater acceptance timed out');
}

function runInstaller(file, args, expectedExit = 0) {
  const start = performance.now();
  const result = spawnSync(file, args, {
    cwd: path.dirname(file),
    env: environment,
    windowsHide: true,
    timeout: 900_000,
    stdio: 'ignore',
  });
  assert.ifError(result.error);
  assert.equal(result.status, expectedExit, `${path.basename(file)} exited with ${result.status}`);
  return Math.round(performance.now() - start);
}

async function uninstallApplication(root) {
  runInstaller(path.join(root, 'Uninstall antigravity-manager.exe'), ['/S']);
  await until(() => !existsSync(root), 90_000);
}

let feedMode = 'error';
const server = createServer(async (request, response) => {
  if (feedMode === 'error') {
    response.writeHead(503).end();
    return;
  }
  const name = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
  if (name === '/nsis/latest.yml') {
    const bytes = await readFile(metadataFile);
    response.writeHead(200, { 'Content-Length': bytes.length, 'Cache-Control': 'no-store' });
    response.end(bytes);
    return;
  }
  if (name === `/nsis/${path.basename(currentInstaller)}`) {
    if (feedMode === 'tampered') {
      response.writeHead(200, { 'Content-Length': 8, 'Cache-Control': 'no-store' });
      response.end('tampered');
      return;
    }
    const info = await stat(currentInstaller);
    response.writeHead(200, { 'Content-Length': info.size, 'Cache-Control': 'no-store' });
    createReadStream(currentInstaller).pipe(response);
    return;
  }
  response.writeHead(404).end();
});

// The two installers evolve independently; preserve user shortcuts even when NSIS recreates them.
const shortcuts = [
  path.join(os.homedir(), 'Desktop', 'Antigravity Manager.lnk'),
  path.join(
    process.env.APPDATA,
    'Microsoft',
    'Windows',
    'Start Menu',
    'Programs',
    'Antigravity Manager.lnk',
  ),
  path.join(
    process.env.APPDATA,
    'Microsoft',
    'Windows',
    'Start Menu',
    'Programs',
    'Draculabo',
    'Antigravity Manager.lnk',
  ),
];
const originalShortcuts = new Map();
const report = {
  architecture: process.arch,
  windows: os.release(),
  previousInstaller: path.basename(previousInstaller),
  candidateInstaller: path.basename(currentInstaller),
  candidateSha512: metadata.files[0].sha512,
  currentVersion,
};
for (const file of shortcuts) {
  try {
    originalShortcuts.set(file, await readFile(file));
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
    originalShortcuts.set(file, null);
  }
}
await writeFile(loginBackup, loginSettings('snapshot', loginBackup));
await writeFile(squirrelRegistryBackup, squirrelRegistration('snapshot-if-present'));
let installRoot = requestedInstall;
let child;
let browser;
let succeeded = false;
let acceptanceError;
let recoveryError;
function resolveInstalledRoot() {
  const installed = installRoots.find((root) =>
    existsSync(path.join(root, 'antigravity-manager.exe')),
  );
  assert(installed, 'NSIS installer did not install the app');
  return installed;
}

try {
  await mkdir(userData, { recursive: true });
  await writeFile(marker, 'NSIS update retains external profile data.');

  const logsBeforeFresh = await listNsisAttemptLogs(diagnosticDirectory);
  console.log('Installing the candidate and checking its native diagnostic log.');
  report.candidateSilentInstallMs = runInstaller(currentInstaller, [
    '/S',
    `/D=${requestedInstall}`,
  ]);
  installRoot = resolveInstalledRoot();
  const freshAsar = path.join(installRoot, 'resources', 'app.asar');
  assert.equal(
    JSON.parse(extractFile(freshAsar, 'package.json').toString()).version,
    currentVersion,
  );
  report.freshInstallStages = await readNsisAttempt(diagnosticDirectory, logsBeforeFresh, {
    version: currentVersion,
    mode: 'silent',
    outcome: 'ok',
    stages: installationStages,
  });
  console.log('Uninstalling the candidate and waiting for directory cleanup.');
  await uninstallApplication(installRoot);
  installRoot = requestedInstall;

  console.log('Installing the previous version for the update check.');
  report.previousSilentInstallMs = runInstaller(previousInstaller, [
    '/S',
    `/D=${requestedInstall}`,
  ]);
  installRoot = resolveInstalledRoot();
  const executable = path.join(installRoot, 'antigravity-manager.exe');
  const uninstaller = path.join(installRoot, 'Uninstall antigravity-manager.exe');
  assert((await stat(executable)).isFile(), 'Previous NSIS installer did not install the app');
  assert((await stat(uninstaller)).isFile());
  stopFixtureApps(installRoot);
  const asar = path.join(installRoot, 'resources', 'app.asar');
  uncache(asar);
  assert.notEqual(JSON.parse(extractFile(asar, 'package.json').toString()).version, currentVersion);

  if (incompleteInstaller) {
    console.log('Checking that an incomplete candidate preserves the previous version.');
    const installationDigests = async () => {
      const digests = [];
      for (const file of [executable, asar, uninstaller]) {
        const digest = createHash('sha256');
        for await (const chunk of createReadStream(file)) {
          digest.update(chunk);
        }
        digests.push(digest.digest('hex'));
      }
      return digests;
    };
    const before = await installationDigests();
    const logsBeforeFailure = await listNsisAttemptLogs(diagnosticDirectory);
    runInstaller(incompleteInstaller, ['/S', '--updated'], 2);
    assert.deepEqual(await installationDigests(), before);
    assert.equal(await readFile(marker, 'utf8'), 'NSIS update retains external profile data.');
    report.rejectedIncompleteStages = await readNsisAttempt(
      diagnosticDirectory,
      logsBeforeFailure,
      {
        version: currentVersion,
        mode: 'update',
        outcome: 'failed',
        stages: preparationStages,
        error: 'required-files-missing',
      },
    );
    console.log('An incomplete installer was rejected with the previous installation intact.');
  }

  const externalDirectory = path.join(directory, 'external');
  const externalMarker = path.join(externalDirectory, 'retained-marker.txt');
  await mkdir(externalDirectory);
  await writeFile(externalMarker, 'Backup cleanup must not follow this directory link.');
  await symlink(externalDirectory, path.join(installRoot, 'acceptance-junction'), 'junction');
  const fixtureLayout = installRoot === requestedInstall ? (await readdir(directory)).sort() : null;

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  environment.AGM_UPDATE_FEED_URL = `http://127.0.0.1:${server.address().port}/nsis`;
  const reservation = createServer();
  const debuggerPort = await new Promise((resolve, reject) => {
    reservation.once('error', reject);
    reservation.listen(0, '127.0.0.1', () => {
      const port = reservation.address().port;
      reservation.close(() => resolve(port));
    });
  });
  child = spawn(
    executable,
    [`--user-data-dir=${userData}`, `--remote-debugging-port=${debuggerPort}`],
    {
      cwd: installRoot,
      env: environment,
      windowsHide: false,
      stdio: 'ignore',
    },
  );
  await once(child, 'spawn');
  await until(async () => {
    assert.equal(child.exitCode, null, 'Previous NSIS app exited before update check');
    try {
      return (
        await fetch(`http://127.0.0.1:${debuggerPort}/json/version`, {
          signal: AbortSignal.timeout(1500),
        })
      ).ok;
    } catch {
      return false;
    }
  });
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${debuggerPort}`);
  const page = await until(() =>
    browser
      .contexts()[0]
      ?.pages()
      .find((tab) => tab.url().startsWith('file:')),
  );
  await page.bringToFront();
  await page.getByRole('main').waitFor({ state: 'visible', timeout: 45_000 });

  await page.evaluate(() => window.electron.checkForUpdates());
  assert((await stat(executable)).isFile());
  assert.equal(await readFile(marker, 'utf8'), 'NSIS update retains external profile data.');
  console.log('Unavailable NSIS feed left the installed app and isolated profile intact.');

  feedMode = 'tampered';
  const rejected = await page.evaluate(() => window.electron.checkForUpdates());
  assert.equal(rejected.status, 'available');
  await until(async () => {
    const logDirectory = path.join(profile, '.antigravity-agent');
    const logs = await readdir(logDirectory).catch(() => []);
    for (const file of logs.filter((name) => /^app-.*\.log$/.test(name))) {
      if (
        (await readFile(path.join(logDirectory, file), 'utf8')).includes('sha512 checksum mismatch')
      ) {
        return true;
      }
    }
    return false;
  }, 15_000);
  assert.deepEqual(await page.evaluate(() => window.electron.installUpdate()), {
    status: 'not-available',
  });
  assert.notEqual(JSON.parse(extractFile(asar, 'package.json').toString()).version, currentVersion);
  console.log('Tampered NSIS installer was rejected without replacing the app.');

  feedMode = 'valid';
  const downloaded = await page.evaluate(async () => {
    const ready = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('NSIS download event timed out')), 300_000);
      const unsubscribe = window.electron.onManualUpdateAvailable((update) => {
        if (update.state === 'downloaded') {
          clearTimeout(timeout);
          unsubscribe();
          resolve(update);
        }
      });
    });
    const result = await window.electron.checkForUpdates();
    return { result, update: await ready };
  });
  assert.equal(downloaded.result.status, 'available');
  assert.equal(downloaded.update.version, currentVersion);
  assert.equal(downloaded.update.state, 'downloaded');
  console.log('Installed NSIS app downloaded the current exe through electron-updater.');

  const exited = once(child, 'exit');
  const logsBeforeUpdate = await listNsisAttemptLogs(diagnosticDirectory);
  const updateStart = performance.now();
  await page.locator('div.fixed.top-4 button').last().click();
  let exitTimeout;
  try {
    await Promise.race([
      exited,
      new Promise((_, reject) => {
        exitTimeout = setTimeout(
          () => reject(new Error('Restart did not close the previous NSIS app')),
          90_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(exitTimeout);
  }
  report.restartToPreviousExitMs = Math.round(performance.now() - updateStart);
  await browser.close();
  browser = null;
  await until(() => {
    try {
      uncache(asar);
      return JSON.parse(extractFile(asar, 'package.json').toString()).version === currentVersion;
    } catch {
      return false;
    }
  }, 900_000);
  await until(() => installedAppWindowReady(installRoot), 240_000);
  report.restartToResponsiveMainWindowMs = Math.round(performance.now() - updateStart);
  report.updateStages = await readNsisAttempt(diagnosticDirectory, logsBeforeUpdate, {
    version: currentVersion,
    mode: 'update',
    outcome: 'ok',
    stages: installationStages,
  });
  assert.equal(await readFile(marker, 'utf8'), 'NSIS update retains external profile data.');
  assert.equal(
    await readFile(externalMarker, 'utf8'),
    'Backup cleanup must not follow this directory link.',
  );
  if (fixtureLayout) {
    assert.deepEqual((await readdir(directory)).sort(), fixtureLayout);
  }
  console.log('NSIS installer replaced the app, relaunched it and retained the external profile.');
  succeeded = true;
} catch (error) {
  acceptanceError = error;
}

try {
  if (browser) {
    await browser.close();
  }
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill();
  }
  if (server.listening) {
    await new Promise((resolve) => server.close(resolve));
  }
  stopFixtureApps(installRoot);
  for (const root of installRoots) {
    const uninstaller = path.join(root, 'Uninstall antigravity-manager.exe');
    if (existsSync(uninstaller)) {
      await uninstallApplication(root);
    }
  }
  const savedSquirrelRegistration = await readFile(squirrelRegistryBackup, 'utf8');
  if (
    savedSquirrelRegistration !== 'null' &&
    squirrelRegistration('snapshot-if-present') !== savedSquirrelRegistration
  ) {
    squirrelRegistration('restore', savedSquirrelRegistration);
  }
  assert.equal(squirrelRegistration('snapshot-if-present'), savedSquirrelRegistration);
  loginSettings('restore', loginBackup);
  for (const [file, bytes] of originalShortcuts) {
    if (bytes === null) {
      await rm(file, { force: true });
    } else {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, bytes);
      assert.deepEqual(await readFile(file), bytes);
    }
  }
  if (succeeded) {
    assert.equal(path.dirname(await realpath(directory)), temporaryParent);
    assert(path.basename(directory).startsWith('agm-nsis-update-'));
    await rm(directory, { recursive: true, force: true, maxRetries: 15, retryDelay: 500 });
  }
} catch (error) {
  recoveryError = error;
}
if (acceptanceError || recoveryError) {
  throw new AggregateError(
    [acceptanceError, recoveryError].filter(Boolean),
    `Installed NSIS updater acceptance/recovery failed; diagnostics: ${directory}`,
  );
}
const reportDirectory = await mkdtemp(path.join(outRoot, 'nsis-acceptance-'));
await writeFile(path.join(reportDirectory, 'result.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(`NSIS acceptance report: ${reportDirectory}`);
console.log(
  'Installed NSIS A-to-B updater acceptance passed; shortcuts and login settings restored.',
);
