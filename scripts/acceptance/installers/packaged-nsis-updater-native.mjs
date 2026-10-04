import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { extractFile, uncache } from '@electron/asar';
import YAML from 'yaml';
import { loginSettings } from '../helpers/windows-login-settings.mjs';
import { squirrelRegistration } from '../helpers/windows-squirrel-registration.mjs';

assert.equal(process.platform, 'win32');
assert.equal(process.arch, 'x64');
assert.equal(
  process.argv.length,
  5,
  'Supply previous NSIS installer, current installer and current metadata',
);
const project = await realpath(process.cwd());
const outRoot = await realpath(path.join(project, 'out'));
const previousInstaller = await realpath(path.resolve(process.argv[2]));
const currentInstaller = await realpath(path.resolve(process.argv[3]));
const metadataFile = await realpath(path.resolve(process.argv[4]));
for (const file of [previousInstaller, currentInstaller, metadataFile]) {
  assert(file.startsWith(`${outRoot}${path.sep}`));
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

function runInstaller(file, args) {
  const result = spawnSync(file, args, {
    cwd: path.dirname(file),
    env: environment,
    windowsHide: true,
    timeout: 300_000,
    stdio: 'ignore',
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, `${path.basename(file)} exited with ${result.status}`);
}

function fixtureProcesses(command, installRoot) {
  const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', command], {
    env: { ...process.env, AGM_TEST_INSTALL_ROOT: installRoot },
    windowsHide: true,
    timeout: 15_000,
    encoding: 'utf8',
    maxBuffer: 4000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0);
  return result.stdout.trim();
}

function installedAppIsRunning(installRoot) {
  return (
    fixtureProcesses(
      '$root=[IO.Path]::GetFullPath($env:AGM_TEST_INSTALL_ROOT); Get-CimInstance Win32_Process -Filter "Name = \'antigravity-manager.exe\'" | Where-Object { $_.ExecutablePath -and [IO.Path]::GetFullPath($_.ExecutablePath).StartsWith($root,[StringComparison]::OrdinalIgnoreCase) } | Select-Object -First 1 -ExpandProperty ProcessId',
      installRoot,
    ).length > 0
  );
}

function stopFixtureApps(installRoot) {
  fixtureProcesses(
    '$root=[IO.Path]::GetFullPath($env:AGM_TEST_INSTALL_ROOT); Get-CimInstance Win32_Process -Filter "Name = \'antigravity-manager.exe\'" | Where-Object { $_.ExecutablePath -and [IO.Path]::GetFullPath($_.ExecutablePath).StartsWith($root,[StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }',
    installRoot,
  );
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
await writeFile(squirrelRegistryBackup, squirrelRegistration('snapshot'));
let installRoot = requestedInstall;
let child;
let browser;
let succeeded = false;
let acceptanceError;
let recoveryError;
try {
  await mkdir(userData, { recursive: true });
  await writeFile(marker, 'NSIS update retains external profile data.');
  runInstaller(previousInstaller, ['/S', `/D=${requestedInstall}`]);
  if (!existsSync(path.join(requestedInstall, 'antigravity-manager.exe'))) {
    installRoot = existsSync(path.join(profileDefaultInstall, 'antigravity-manager.exe'))
      ? profileDefaultInstall
      : defaultInstall;
  }
  const executable = path.join(installRoot, 'antigravity-manager.exe');
  assert((await stat(executable)).isFile(), 'Previous NSIS installer did not install the app');
  assert((await stat(path.join(installRoot, 'Uninstall antigravity-manager.exe'))).isFile());
  stopFixtureApps(installRoot);
  const asar = path.join(installRoot, 'resources', 'app.asar');
  assert.notEqual(JSON.parse(extractFile(asar, 'package.json').toString()).version, currentVersion);

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
  await browser.close();
  browser = null;
  await until(() => {
    try {
      uncache(asar);
      return JSON.parse(extractFile(asar, 'package.json').toString()).version === currentVersion;
    } catch {
      return false;
    }
  }, 120_000);
  await until(() => installedAppIsRunning(installRoot), 240_000);
  assert.equal(await readFile(marker, 'utf8'), 'NSIS update retains external profile data.');
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
  const uninstaller = path.join(installRoot, 'Uninstall antigravity-manager.exe');
  if (existsSync(uninstaller)) {
    runInstaller(uninstaller, ['/S']);
  }
  const savedSquirrelRegistration = await readFile(squirrelRegistryBackup, 'utf8');
  if (squirrelRegistration('snapshot') !== savedSquirrelRegistration) {
    squirrelRegistration('restore', savedSquirrelRegistration);
  }
  assert.equal(squirrelRegistration('snapshot'), savedSquirrelRegistration);
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
console.log(
  'Installed NSIS A-to-B updater acceptance passed; shortcuts and login settings restored.',
);
