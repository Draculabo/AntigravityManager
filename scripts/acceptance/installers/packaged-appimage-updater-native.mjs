import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createReadStream } from 'node:fs';
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import YAML from 'yaml';

assert.equal(process.platform, 'linux', 'Run installed AppImage acceptance on a Linux desktop');
assert(['x64', 'arm64'].includes(process.arch));
assert.equal(
  process.argv.length,
  5,
  'Supply previous AppImage, current AppImage, and current latest-linux metadata under out',
);
const project = await realpath(process.cwd());
const outRoot = await realpath(path.join(project, 'out'));
const [previous, current, metadataPath] = await Promise.all(
  process.argv.slice(2).map((file) => realpath(file)),
);
for (const file of [previous, current, metadataPath]) {
  assert(file.startsWith(`${outRoot}${path.sep}`));
  assert((await stat(file)).isFile());
}
const metadata = YAML.parse(await readFile(metadataPath, 'utf8'));
assert.match(metadata.version, /^\d+\.\d+\.\d+$/);
assert.equal(metadata.files.length, 1);
assert.equal(metadata.files[0].url, path.basename(current));
const checksum = async (file) => {
  const digest = createHash('sha512');
  for await (const chunk of createReadStream(file)) {
    digest.update(chunk);
  }
  return digest.digest('base64');
};
assert.equal(metadata.files[0].sha512, await checksum(current));
assert.notEqual(await checksum(previous), metadata.files[0].sha512);
const parent = await realpath(os.tmpdir());
const directory = await mkdtemp(path.join(parent, 'agm-appimage-update-'));
const executable = path.join(directory, 'Manager.AppImage');
await copyFile(previous, executable);
await chmod(executable, 0o755);
const originalDigest = await checksum(executable);
const home = path.join(directory, 'home');
const configuration = path.join(home, '.config');
const userData = path.join(configuration, 'Antigravity Manager');
await mkdir(userData, { recursive: true });
const marker = path.join(userData, 'retained-marker.txt');
await writeFile(marker, 'AppImage update retains the isolated profile.');
const identity = randomUUID();
let mode = 'unavailable';
const server = createServer(async (request, response) => {
  const name = new URL(request.url, 'http://127.0.0.1').pathname.slice(1);
  if (mode === 'unavailable') {
    response.writeHead(503).end();
    return;
  }
  if (name === (process.arch === 'x64' ? 'latest-linux.yml' : 'latest-linux-arm64.yml')) {
    response.end(YAML.stringify(metadata));
    return;
  }
  if (name !== path.basename(current)) {
    response.writeHead(404).end();
    return;
  }
  if (mode === 'tampered') {
    response.writeHead(200, { 'Content-Length': 8 });
    response.end('tampered');
    return;
  }
  response.writeHead(200, { 'Content-Length': (await stat(current)).size });
  createReadStream(current).pipe(response);
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const environment = {
  ...process.env,
  HOME: home,
  XDG_CONFIG_HOME: configuration,
  XDG_CACHE_HOME: path.join(home, '.cache'),
  XDG_DATA_HOME: path.join(home, '.local/share'),
  AGM_APPIMAGE_ACCEPTANCE_ID: identity,
  AGM_UPDATE_ALLOW_UNMANAGED: '1',
  AGM_UPDATE_FEED_URL: `http://127.0.0.1:${server.address().port}`,
  ANTIGRAVITY_ENABLE_PERFORMANCE_RECORDER: '1',
  ANTIGRAVITY_PERFORMANCE_DEBUG_PORT: '0',
};
for (const key of ['NODE_OPTIONS', 'NODE_PATH', 'ELECTRON_RUN_AS_NODE', 'APPIMAGE', 'APPDIR']) {
  delete environment[key];
}
async function until(check, timeout = 60_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) {
      return result;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('AppImage updater acceptance timed out');
}
async function connect() {
  const endpoint = await until(async () => {
    try {
      const port = Number(
        (await readFile(path.join(userData, 'DevToolsActivePort'), 'utf8')).split('\n')[0],
      );
      if (!Number.isInteger(port) || port < 1024 || port > 65535) {
        return false;
      }
      const address = `http://127.0.0.1:${port}`;
      return (await fetch(`${address}/json/version`, { signal: AbortSignal.timeout(1000) })).ok
        ? address
        : false;
    } catch {
      return false;
    }
  });
  const connection = await chromium.connectOverCDP(endpoint);
  const page = await until(() =>
    connection
      .contexts()[0]
      ?.pages()
      .find((item) => item.url().startsWith('file:')),
  );
  await page.bringToFront();
  await page.getByRole('main').waitFor({ state: 'visible', timeout: 45_000 });
  return { connection, page };
}
async function stopOwnedProcesses() {
  const owned = [];
  for (const entry of await readdir('/proc')) {
    if (!/^\d+$/.test(entry)) {
      continue;
    }
    try {
      const variables = (await readFile(`/proc/${entry}/environ`, 'utf8')).split('\0');
      if (variables.includes(`AGM_APPIMAGE_ACCEPTANCE_ID=${identity}`)) {
        owned.push(Number(entry));
        process.kill(Number(entry), 'SIGTERM');
      }
    } catch (error) {
      if (!['ENOENT', 'ESRCH', 'EACCES'].includes(error.code)) {
        throw error;
      }
    }
  }
  await until(
    () =>
      owned.every((pid) => {
        try {
          process.kill(pid, 0);
          return false;
        } catch (error) {
          if (error.code === 'ESRCH') {
            return true;
          }
          throw error;
        }
      }),
    15_000,
  );
}
let browser;
let success = false;
const processLog = await open(path.join(directory, 'app-process.log'), 'a');
try {
  const child = spawn(executable, [], {
    cwd: directory,
    env: environment,
    stdio: ['ignore', processLog.fd, processLog.fd],
  });
  await once(child, 'spawn');
  let connected = await connect();
  browser = connected.connection;
  let page = connected.page;
  await page.evaluate(() => window.electron.checkForUpdates());
  console.log('Unavailable local feed left the installed archive intact.');
  assert.equal(await checksum(executable), originalDigest);
  mode = 'tampered';
  await page.evaluate(async () => {
    const failed = new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('Tampered download was not rejected')),
        60_000,
      );
      const stop = window.electron.onManualUpdateAvailable((update) => {
        if (update.source === 'electron-updater' && update.state === 'error') {
          clearTimeout(timer);
          stop();
          resolve();
        }
      });
    });
    await window.electron.checkForUpdates();
    await failed;
  });
  assert.deepEqual(await page.evaluate(() => window.electron.installUpdate()), {
    status: 'not-available',
  });
  assert.equal(await checksum(executable), originalDigest);
  mode = 'valid';
  console.log('Corrupt archive was rejected and installation stayed unavailable.');
  const downloaded = await page.evaluate(async () => {
    const ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Download did not complete')), 300_000);
      const stop = window.electron.onManualUpdateAvailable((update) => {
        if (update.state === 'downloaded') {
          clearTimeout(timer);
          stop();
          resolve(update);
        }
      });
    });
    await window.electron.downloadUpdate();
    return await ready;
  });
  assert.equal(downloaded.version, metadata.version);
  assert.equal(await checksum(executable), originalDigest, 'Download alone must not install');
  console.log('Verified download completed without installing before the restart action.');
  const exited = once(child, 'exit');
  await rm(path.join(userData, 'DevToolsActivePort'));
  await page.locator('div.fixed.top-4 button').last().click();
  await Promise.race([
    exited,
    new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error('Previous app did not exit')), 90_000);
      timer.unref();
    }),
  ]);
  await browser.close();
  browser = null;
  await until(
    async () => (await checksum(executable).catch(() => null)) === metadata.files[0].sha512,
  );
  connected = await connect();
  browser = connected.connection;
  page = connected.page;
  await page.locator('a[href$="/settings"]').click();
  const renderedVersion = page.getByRole('main').getByText(metadata.version, { exact: true });
  await renderedVersion.waitFor({ state: 'visible', timeout: 30_000 });
  await renderedVersion.scrollIntoViewIfNeeded();
  assert.equal(await readFile(marker, 'utf8'), 'AppImage update retains the isolated profile.');
  const evidence = path.join(outRoot, `appimage-update-acceptance-${identity}`);
  await page.screenshot({ path: `${evidence}.png` });
  await writeFile(
    `${evidence}.json`,
    `${JSON.stringify(
      {
        platform: process.platform,
        arch: process.arch,
        version: metadata.version,
        sha512: metadata.files[0].sha512,
        checks: [
          'unavailable-feed',
          'corrupt-download-rejected',
          'download-without-install',
          'explicit-restart',
          'replacement-checksum',
          'relaunched-settings-version',
          'profile-retained',
        ],
      },
      null,
      2,
    )}\n`,
  );
  console.log(`Acceptance evidence: ${evidence}.json`);
  success = true;
  console.log(
    'AppImage update rejected corruption, replaced only the fixture, relaunched, and retained its profile.',
  );
} finally {
  await browser?.close().catch(() => {});
  await stopOwnedProcesses();
  await processLog.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  if (success) {
    assert.equal(path.dirname(await realpath(directory)), parent);
    await rm(directory, { recursive: true, force: true });
  } else {
    console.error(`AppImage acceptance fixture retained for diagnosis: ${directory}`);
  }
}
