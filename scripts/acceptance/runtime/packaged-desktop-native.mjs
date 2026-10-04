import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as wait } from 'node:timers/promises';
import { chromium } from 'playwright';
import { build, loadConfigFromFile } from 'vite';
import { loginSettings } from '../helpers/windows-login-settings.mjs';

assert.equal(process.platform, 'win32', 'This acceptance owns Windows login-setting restoration');
assert.equal(process.argv.length, 3, 'Supply the actual packaged desktop executable');
const executable = await realpath(path.resolve(process.argv[2]));
assert.equal(path.basename(executable), 'antigravity-manager.exe');
const project = process.cwd();
const temporaryParent = await realpath(os.tmpdir());
const directory = await mkdtemp(path.join(temporaryParent, 'agm-packaged-desktop-'));
const home = path.join(directory, 'home');
const userData = path.join(directory, 'desktop-data');
const backup = path.join(directory, 'login-settings.json');
const children = [];
const memory = [];
let connection;
const resources = path.join(path.dirname(executable), 'resources', 'standalone');
const environment = {
  ...process.env,
  HOME: home,
  USERPROFILE: home,
  APPDATA: path.join(home, 'AppData', 'Roaming'),
  LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
};
delete environment.NODE_OPTIONS;
delete environment.NODE_PATH;
delete environment.ELECTRON_RUN_AS_NODE;

function observeMemory(role, pid) {
  assert(Number.isSafeInteger(pid) && pid > 0);
  const result = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-Command',
      `$sample = Get-Process -Id ${pid} -ErrorAction Stop; @{workingSetKiB=[math]::Ceiling($sample.WorkingSet64/1024); peakWorkingSetKiB=[math]::Ceiling($sample.PeakWorkingSet64/1024)} | ConvertTo-Json -Compress`,
    ],
    { windowsHide: true, encoding: 'utf8', timeout: 5000, maxBuffer: 4000 },
  );
  assert(!result.error && result.status === 0, 'Process memory observation failed');
  const sample = JSON.parse(result.stdout);
  assert(Number.isSafeInteger(sample.workingSetKiB) && sample.workingSetKiB > 0);
  assert(
    Number.isSafeInteger(sample.peakWorkingSetKiB) &&
      sample.peakWorkingSetKiB >= sample.workingSetKiB,
  );
  memory.push({ role, ...sample });
}

async function until(check, timeout = 45_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) {
      return result;
    }
    await wait(100);
  }
  throw new Error('Packaged desktop observation timed out');
}

async function launch() {
  const reservation = createServer();
  await new Promise((resolve, reject) => {
    reservation.once('error', reject);
    reservation.listen(0, '127.0.0.1', resolve);
  });
  const address = reservation.address();
  assert(address && typeof address !== 'string');
  await new Promise((resolve) => reservation.close(resolve));
  const child = spawn(
    executable,
    [`--user-data-dir=${userData}`, `--remote-debugging-port=${address.port}`],
    { env: environment, cwd: path.dirname(executable), windowsHide: true, stdio: 'ignore' },
  );
  children.push(child);
  await once(child, 'spawn');
  const endpoint = `http://127.0.0.1:${address.port}`;
  await until(async () => {
    assert.equal(child.exitCode, null, 'Packaged desktop exited before window readiness');
    try {
      const response = await fetch(`${endpoint}/json/version`, {
        signal: AbortSignal.timeout(1500),
      });
      return response.ok;
    } catch {
      return false;
    }
  });
  const browser = await chromium.connectOverCDP(endpoint);
  const page = await until(() =>
    browser
      .contexts()[0]
      ?.pages()
      .find((candidate) => candidate.url().startsWith('file:')),
  );
  await page.getByRole('main').waitFor({ state: 'visible', timeout: 45_000 });
  await page.locator('a[href="/settings"]').first().click();
  await page.locator('h2').first().waitFor({ state: 'visible', timeout: 15_000 });
  return { child, browser, page };
}

async function closeDesktop(desktop) {
  const closed = once(desktop.child, 'exit');
  const session = await desktop.browser.newBrowserCDPSession();
  // Electron's Browser.close invokes Browser::Quit, including the before-quit drain.
  void session.send('Browser.close').catch(() => undefined);
  await Promise.race([
    closed,
    wait(40_000, undefined, { ref: false }).then(() => {
      throw new Error('Packaged desktop did not finish its terminal shutdown');
    }),
  ]);
  assert.equal(desktop.child.exitCode, 0);
  await desktop.browser.close();
}

function runCli(command) {
  const result = spawnSync(
    path.join(resources, 'node', 'node.exe'),
    [path.join(resources, 'cli', 'main.cjs'), 'service', command],
    {
      env: environment,
      cwd: directory,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 25_000,
      maxBuffer: 8000,
    },
  );
  if (result.error) {
    throw result.error;
  }
  assert.equal(result.status, 0, (result.stderr ?? '').slice(-2000));
}

try {
  await writeFile(backup, loginSettings('snapshot', backup));
  await mkdir(userData, { recursive: true });
  await mkdir(path.join(home, '.antigravity-agent'), { recursive: true });
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
    ssr: { noExternal: true, external: [] },
    build: {
      ...loaded.config.build,
      outDir: path.join(directory, 'fixture'),
      sourcemap: false,
      rollupOptions: {
        external: [],
        input: path.join(project, 'scripts/acceptance/runtime/packaged-desktop-fixture.ts'),
        output: { format: 'cjs', entryFileNames: 'fixture.cjs' },
      },
    },
  });
  const fixture = await import(pathToFileURL(path.join(directory, 'fixture', 'fixture.cjs')).href);
  const preferencesPath = path.join(userData, 'desktop-preferences.json');
  await writeFile(
    path.join(home, '.antigravity-agent', 'gui_config.json'),
    JSON.stringify(fixture.config),
  );
  await writeFile(
    preferencesPath,
    JSON.stringify({
      version: 1,
      preferences: { ...fixture.preferences, owner_mode: 'desktop-embedded' },
    }),
  );
  connection = fixture.connection(home);
  const desktopEmbedded = await launch();
  assert.deepEqual(await connection.probe(), {
    version: 1,
    kind: 'desktop',
    pid: desktopEmbedded.child.pid,
  });
  observeMemory('desktop-embedded-main', desktopEmbedded.child.pid);
  await desktopEmbedded.page.screenshot({
    path: path.join(project, 'artifacts/runtime24-desktop-embedded.png'),
  });
  await closeDesktop(desktopEmbedded);
  assert.equal(await connection.probe(), null);
  console.log(
    'Actual packaged Electron desktop-embedded startup, navigation and terminal release passed.',
  );

  const preferences = JSON.parse(await readFile(preferencesPath, 'utf8'));
  preferences.preferences.owner_mode = 'standalone-core';
  await writeFile(preferencesPath, JSON.stringify(preferences));
  const standaloneCore = await launch();
  const handshake = await connection.management.handshake();
  assert.notEqual(handshake.pid, standaloneCore.child.pid);
  assert.deepEqual(await connection.probe(), { version: 1, kind: 'core', pid: handshake.pid });
  observeMemory('standalone-core-desktop-main', standaloneCore.child.pid);
  observeMemory('standalone-core-idle', handshake.pid);
  await standaloneCore.page.screenshot({
    path: path.join(project, 'artifacts/runtime24-desktop-standalone-core.png'),
  });
  await closeDesktop(standaloneCore);
  assert.equal(await connection.probe(), null);
  console.log(
    'Actual packaged Electron standalone-core startup, navigation and launched-core terminal release passed.',
  );

  const reopened = await launch();
  assert.equal(
    JSON.parse(await readFile(preferencesPath, 'utf8')).preferences.owner_mode,
    'standalone-core',
  );
  assert.equal((await connection.probe()).kind, 'core');
  await closeDesktop(reopened);
  assert.equal(await connection.probe(), null);
  console.log('Actual packaged desktop preference restart and standalone-core reopen passed.');

  runCli('start');
  const external = await connection.management.handshake();
  const attached = await launch();
  assert.equal((await connection.management.handshake()).epoch, external.epoch);
  await closeDesktop(attached);
  assert.equal((await connection.management.handshake()).epoch, external.epoch);
  runCli('stop');
  await until(async () => (await connection.probe()) === null);
  console.log('Packaged CLI start/stop and actual Electron external-core retention passed.');

  const crashingDesktop = await launch();
  const retained = await connection.management.handshake();
  const crashedExit = once(crashingDesktop.child, 'exit');
  crashingDesktop.child.kill('SIGKILL');
  await crashedExit;
  await crashingDesktop.browser.close();
  assert.equal((await connection.management.handshake()).epoch, retained.epoch);
  const afterCrash = await launch();
  assert.equal((await connection.management.handshake()).epoch, retained.epoch);
  await closeDesktop(afterCrash);
  assert.equal((await connection.management.handshake()).epoch, retained.epoch);
  runCli('stop');
  await until(async () => (await connection.probe()) === null);
  console.log(
    'Actual Electron crash/restart retained one core owner without a desktop-embedded fallback.',
  );
  const lostCoreDesktop = await launch();
  const lost = await connection.management.handshake();
  assert.equal((await connection.probe()).pid, lost.pid);
  process.kill(lost.pid, 'SIGKILL');
  console.log('Attached core termination requested.');
  // Wait for OS termination before querying the lease: an in-flight identity reply can be truncated.
  await until(() => {
    try {
      process.kill(lost.pid, 0);
      return false;
    } catch (error) {
      if (error.code === 'ESRCH') {
        return true;
      }
      throw error;
    }
  });
  console.log('Attached core process termination observed.');
  await until(async () => {
    try {
      return (await connection.probe()) === null;
    } catch (error) {
      // Windows can finish a previously accepted pipe connection after its owner has died.
      // Keep waiting for actual endpoint absence; a persistent malformed endpoint still fails.
      if (error instanceof SyntaxError) {
        return false;
      }
      throw error;
    }
  });
  console.log('Attached core endpoint release observed.');
  await closeDesktop(lostCoreDesktop);
  assert.equal(await connection.probe(), null);
  const afterCoreCrash = await launch();
  assert.equal((await connection.probe()).kind, 'core');
  await closeDesktop(afterCoreCrash);
  assert.equal(await connection.probe(), null);
  console.log(
    'Actual core loss while Electron is attached and subsequent standalone-core restart passed.',
  );
} finally {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill();
      await exited;
    }
  }
  try {
    if ((await connection?.probe())?.kind === 'core') {
      await connection.management.shutdown();
      await until(async () => (await connection.probe()) === null, 15_000);
    }
  } finally {
    loginSettings('restore', backup);
    assert.equal(loginSettings('snapshot', backup), (await readFile(backup, 'utf8')).trim());
    console.log('Application login settings restored.');
  }
  assert.equal(path.dirname(await realpath(directory)), temporaryParent);
  assert(path.basename(directory).startsWith('agm-packaged-desktop-'));
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
console.log(
  `Desktop acceptance active resource types: ${process.getActiveResourcesInfo().join(', ')}`,
);
await writeFile(
  process.env.AGM_TEST_DESKTOP_MEMORY_OUTPUT ??
    path.join(project, 'artifacts/runtime24-desktop-memory.json'),
  `${JSON.stringify(memory, null, 2)}\n`,
);
console.log(`Actual desktop main/idle core memory KiB: ${JSON.stringify(memory)}`);
