import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { closeSync, createReadStream, existsSync, openSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { chromium } from 'playwright';
import { loginSettings } from '../helpers/windows-login-settings.mjs';
import { squirrelRegistration } from '../helpers/windows-squirrel-registration.mjs';

assert.equal(process.platform, 'win32');
assert.equal(process.arch, 'x64');
assert.equal(process.argv.length, 5, 'Supply authentic installation, previous feed, current feed');
assert(
  !existsSync(path.join(process.env.APPDATA, 'Antigravity Manager')),
  'Run installed Squirrel acceptance from a disposable Windows account with no existing app profile',
);
const source = await realpath(path.resolve(process.argv[2]));
const previousFeed = await realpath(path.resolve(process.argv[3]));
const currentFeed = await realpath(path.resolve(process.argv[4]));
const project = await realpath(process.cwd());
const outputRoot = await realpath(path.join(project, 'out'));
assert(previousFeed.startsWith(`${outputRoot}${path.sep}`));
assert(currentFeed.startsWith(`${outputRoot}${path.sep}`));
const packageJSON = JSON.parse(await readFile('package.json', 'utf8'));
const currentVersion = packageJSON.version;
const parts = currentVersion.split('.').map(Number);
assert(parts.length === 3 && parts[2] > 0);
const previousVersion = `${parts[0]}.${parts[1]}.${parts[2] - 1}`;
for (const [feed, version] of [
  [previousFeed, previousVersion],
  [currentFeed, currentVersion],
]) {
  assert((await stat(path.join(feed, 'RELEASES'))).isFile());
  assert((await stat(path.join(feed, `antigravity_manager-${version}-full.nupkg`))).isFile());
}

const temporaryParent = await realpath(os.tmpdir());
const directory = await mkdtemp(path.join(temporaryParent, 'agm-squirrel-app-update-'));
const fixture = path.join(directory, 'antigravity_manager');
const profile = path.join(directory, 'profile');
const userData = path.join(profile, 'desktop-data');
const marker = path.join(userData, 'retained-marker.txt');
const loginBackup = path.join(directory, 'login-settings.json');
const registryBackup = path.join(directory, 'squirrel-registration.json');
const updateLog = path.join(directory, 'squirrel-previous-update.log');
const packageName = `antigravity_manager-${currentVersion}-full.nupkg`;
const releaseIndex = await readFile(path.join(currentFeed, 'RELEASES'));
const previousReleaseIndex = await readFile(path.join(previousFeed, 'RELEASES'));
const environment = {
  ...process.env,
  HOME: profile,
  USERPROFILE: profile,
  APPDATA: path.join(profile, 'AppData', 'Roaming'),
  // The copied Squirrel root is the install expected under LOCALAPPDATA.
  LOCALAPPDATA: directory,
  AGM_UPDATE_ALLOW_UNMANAGED: '1',
};
delete environment.NODE_OPTIONS;
delete environment.NODE_PATH;
delete environment.ELECTRON_RUN_AS_NODE;

async function digest(file) {
  const hash = createHash('sha256');
  await pipeline(createReadStream(file), hash);
  return hash.digest('hex');
}

function runPreviousUpdate() {
  const logFile = openSync(updateLog, 'w');
  try {
    const result = spawnSync(path.join(fixture, 'Update.exe'), [`--update=${previousFeed}`], {
      cwd: fixture,
      windowsHide: true,
      timeout: 300_000,
      stdio: ['ignore', logFile, logFile],
      env: environment,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, `Previous package update failed; inspect ${updateLog}`);
  } finally {
    closeSync(logFile);
  }
}

function runNode(script, argument) {
  const result = spawnSync(process.execPath, [script, argument], {
    cwd: project,
    windowsHide: true,
    timeout: 300_000,
    encoding: 'utf8',
    maxBuffer: 16_000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, `${script} failed: ${(result.stderr ?? '').slice(-2500)}`);
  process.stdout.write(result.stdout ?? '');
}

function fixtureProcesses(command, target) {
  const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', command], {
    env: { ...process.env, AGM_TEST_FIXTURE_ROOT: fixture, AGM_TEST_CURRENT_EXE: target },
    windowsHide: true,
    timeout: 15_000,
    encoding: 'utf8',
    maxBuffer: 4000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0);
  return result.stdout.trim();
}

function currentAppIsRunning(executable) {
  return (
    fixtureProcesses(
      '$expected=[IO.Path]::GetFullPath($env:AGM_TEST_CURRENT_EXE); Get-CimInstance Win32_Process -Filter "Name = \'antigravity-manager.exe\'" | Where-Object { $_.ExecutablePath -and [IO.Path]::GetFullPath($_.ExecutablePath).Equals($expected,[StringComparison]::OrdinalIgnoreCase) } | Select-Object -First 1 -ExpandProperty ProcessId',
      executable,
    ).length > 0
  );
}

function stopFixtureApps() {
  fixtureProcesses(
    '$root=[IO.Path]::GetFullPath($env:AGM_TEST_FIXTURE_ROOT); Get-CimInstance Win32_Process -Filter "Name = \'antigravity-manager.exe\'" | Where-Object { $_.ExecutablePath -and [IO.Path]::GetFullPath($_.ExecutablePath).StartsWith($root,[StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }',
    '',
  );
}

async function until(check, timeout = 45_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Packaged Squirrel updater observation timed out');
}

const server = createServer(async (request, response) => {
  if (server.mode === 'error') {
    response.writeHead(503).end();
    return;
  }
  if (server.mode === 'interrupted') {
    response.destroy();
    return;
  }
  const name = new URL(request.url ?? '/', 'http://127.0.0.1').pathname.slice(1);
  if (name !== 'RELEASES' && name !== packageName) {
    response.writeHead(404).end();
    return;
  }
  if (name === 'RELEASES') {
    const index = server.mode === 'no-update' ? previousReleaseIndex : releaseIndex;
    response.writeHead(200, {
      'Content-Length': index.length,
      'Cache-Control': 'no-store',
    });
    response.end(index);
    return;
  }
  const file = path.join(currentFeed, name);
  const info = await stat(file);
  response.writeHead(200, { 'Content-Length': info.size, 'Cache-Control': 'no-store' });
  createReadStream(file).pipe(response);
});
server.mode = 'error';

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
const sourceNames = [
  'Update.exe',
  'packages/RELEASES',
  'packages/antigravity_manager-0.19.0-full.nupkg',
];
const sourceDigests = new Map();
for (const name of sourceNames) {
  sourceDigests.set(name, await digest(path.join(source, name)));
}
await writeFile(loginBackup, loginSettings('snapshot', loginBackup));
await writeFile(registryBackup, squirrelRegistration('snapshot'));
let child;
let browser;
let succeeded = false;
let acceptanceError;
let recoveryError;
try {
  await cp(source, fixture, { recursive: true });
  for (const [name, original] of sourceDigests) {
    assert.equal(await digest(path.join(fixture, name)), original);
  }
  await mkdir(userData, { recursive: true });
  await writeFile(marker, 'Squirrel application updater retains external profile data.');
  runPreviousUpdate();
  const previousExe = path.join(fixture, `app-${previousVersion}`, 'antigravity-manager.exe');
  assert((await stat(previousExe)).isFile());
  console.log(`Previous Squirrel fixture ${previousVersion} installed in the isolated copy.`);

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  environment.AGM_UPDATE_FEED_URL = `http://127.0.0.1:${server.address().port}/`;
  const debuggerPort = await new Promise((resolve, reject) => {
    const reservation = createServer();
    reservation.once('error', reject);
    reservation.listen(0, '127.0.0.1', () => {
      const port = reservation.address().port;
      reservation.close(() => resolve(port));
    });
  });
  child = spawn(
    previousExe,
    [`--user-data-dir=${userData}`, `--remote-debugging-port=${debuggerPort}`],
    {
      cwd: path.dirname(previousExe),
      env: environment,
      windowsHide: false,
      stdio: 'ignore',
    },
  );
  await once(child, 'spawn');
  await until(async () => {
    assert.equal(child.exitCode, null, 'Previous app exited before updater acceptance');
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
  assert.equal((await readFile(marker, 'utf8')).startsWith('Squirrel application updater'), true);
  assert.equal((await stat(previousExe)).isFile(), true);
  console.log('Unavailable feed left the previous app and isolated profile intact.');

  server.mode = 'interrupted';
  await page.evaluate(() => window.electron.checkForUpdates());
  server.mode = 'no-update';
  await page.evaluate(() => window.electron.checkForUpdates());
  assert.equal((await stat(previousExe)).isFile(), true);
  console.log('Interrupted and no-update responses left the previous app runnable.');

  server.mode = 'valid';
  const update = await page.evaluate(async () => {
    const downloaded = new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error('Squirrel download event timed out')),
        300_000,
      );
      const unsubscribe = window.electron.onManualUpdateAvailable((update) => {
        if (update.state === 'downloaded') {
          clearTimeout(timeout);
          unsubscribe();
          resolve(update);
        }
      });
    });
    const available = await window.electron.checkForUpdates();
    return { available, downloaded: await downloaded };
  });
  assert.equal(update.available.status, 'available');
  assert.equal(update.available.update.version, currentVersion);
  assert.equal(update.available.update.source, 'electron-updater');
  assert.equal(update.downloaded.version, currentVersion);
  console.log('Actual app updater discovered and downloaded the Squirrel package.');

  const exited = once(child, 'exit');
  await page.locator('div.fixed.top-4 button').last().click();
  let exitTimeout;
  try {
    await Promise.race([
      exited,
      new Promise((_, reject) => {
        exitTimeout = setTimeout(
          () => reject(new Error('Updater restart did not close the previous app')),
          90_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(exitTimeout);
  }
  await browser.close();
  browser = null;
  const currentExe = path.join(fixture, `app-${currentVersion}`, 'antigravity-manager.exe');
  await until(async () => {
    try {
      return (await stat(currentExe)).isFile();
    } catch {
      return false;
    }
  }, 90_000);
  await until(() => currentAppIsRunning(currentExe), 90_000);
  assert.equal(
    await readFile(marker, 'utf8'),
    'Squirrel application updater retains external profile data.',
  );
  console.log(
    'Application updater relaunched the current Squirrel package; profile marker retained.',
  );

  stopFixtureApps();

  for (const [name, original] of sourceDigests) {
    assert.equal(await digest(path.join(source, name)), original, `Host install changed: ${name}`);
  }
  runNode(
    'scripts/acceptance/runtime/installed-runtime-native.mjs',
    path.join(fixture, `app-${currentVersion}`, 'resources', 'standalone'),
  );
  runNode('scripts/acceptance/runtime/packaged-desktop-native.mjs', currentExe);
  succeeded = true;
} catch (error) {
  acceptanceError = error;
}
try {
  if (browser) {
    await browser.close();
  }
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = once(child, 'exit');
    child.kill();
    await exited;
  }
  if (server.listening) {
    await new Promise((resolve) => server.close(resolve));
  }
  stopFixtureApps();
  const savedRegistration = await readFile(registryBackup, 'utf8');
  if (squirrelRegistration('snapshot') !== savedRegistration) {
    squirrelRegistration('restore', savedRegistration);
  }
  assert.equal(squirrelRegistration('snapshot'), savedRegistration);
  loginSettings('restore', loginBackup);
  assert.equal(
    loginSettings('snapshot', loginBackup),
    (await readFile(loginBackup, 'utf8')).trim(),
  );
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
    assert(path.basename(directory).startsWith('agm-squirrel-app-update-'));
    await rm(fixture, { recursive: true, force: true, maxRetries: 15, retryDelay: 500 });
    await rm(userData, { recursive: true, force: true, maxRetries: 15, retryDelay: 500 });
    try {
      await rm(directory, { recursive: true, force: true, maxRetries: 15, retryDelay: 500 });
    } catch (error) {
      if (error.code !== 'EBUSY' && error.code !== 'EPERM') {
        throw error;
      }
      // Windows input-method helpers can keep files below the isolated USERPROFILE open.
      console.warn(`Test profile cleanup is pending: ${directory}`);
    }
  }
} catch (error) {
  recoveryError = error;
}
if (acceptanceError || recoveryError) {
  throw new AggregateError(
    [acceptanceError, recoveryError].filter(Boolean),
    `Packaged Squirrel updater acceptance/recovery failed; diagnostics: ${directory}`,
  );
}
console.log(
  'Packaged Squirrel updater acceptance passed; host registration, shortcuts and login settings restored.',
);
