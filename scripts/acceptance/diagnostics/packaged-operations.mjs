import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { build } from 'vite';
import { chromium } from '@playwright/test';
import { loginSettings } from '../helpers/windows-login-settings.mjs';
import { readPackagedCliDiagnostic } from './packaged-cli-diagnostic.mjs';

assert.equal(process.platform, 'win32');
assert.equal(process.argv.length, 3, 'Supply the actual packaged or installed desktop executable');
const executable = await realpath(path.resolve(process.argv[2]));
assert.equal(path.basename(executable), 'antigravity-manager.exe');
const project = await realpath(process.cwd());
const parent = path.join(project, 'out', 'correlated-diagnostics');
await mkdir(parent, { recursive: true });
const directory = await mkdtemp(path.join(parent, 'installed-operations-'));
const home = path.join(directory, 'home');
const userData = path.join(directory, 'desktop-data');
const resources = path.join(path.dirname(executable), 'resources', 'standalone');
const backup = path.join(directory, 'login-settings.json');
const environment = {
  ...process.env,
  HOME: home,
  USERPROFILE: home,
  APPDATA: path.join(home, 'AppData', 'Roaming'),
  LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
  ANTIGRAVITY_DESKTOP_PREFERENCES_PATH: path.join(userData, 'desktop-preferences.json'),
};
for (const key of ['NODE_OPTIONS', 'NODE_PATH', 'ELECTRON_RUN_AS_NODE', 'SENTRY_AUTH_TOKEN']) {
  delete environment[key];
}
const load = createRequire(path.join(resources, 'package.json'));
const keytar = load('keytar');
async function keyringSnapshot() {
  return Promise.all(
    ['MasterKeyV2', 'MasterKey'].map(async (account) => {
      const value = await keytar.getPassword('AntigravityManager', account);
      return value === null ? null : createHash('sha256').update(value).digest('hex');
    }),
  );
}
const originalKeys = await keyringSnapshot();
assert(
  originalKeys[0],
  'An existing current master key is required; refuse to create a production credential',
);
const observations = [];
const recoveryErrors = [];
let acceptanceError;
let desktop;
let fixture;
let connection;

async function until(action, timeout = 45_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await action();
    if (value) {
      return value;
    }
    await wait(100);
  }
  throw new Error('Installed operation acceptance timed out');
}

async function seed(ownerMode, proxyUrl = '') {
  await mkdir(path.join(home, '.antigravity-agent'), { recursive: true });
  await mkdir(userData, { recursive: true });
  await writeFile(
    path.join(home, '.antigravity-agent', 'gui_config.json'),
    JSON.stringify({
      ...fixture.config,
      proxy: { ...fixture.config.proxy, upstream_proxy: { enabled: true, url: proxyUrl } },
    }),
  );
  await writeFile(
    environment.ANTIGRAVITY_DESKTOP_PREFERENCES_PATH,
    JSON.stringify({ version: 1, preferences: { ...fixture.preferences, owner_mode: ownerMode } }),
  );
}

async function launch() {
  const startedAt = performance.now();
  const reservation = createServer();
  await new Promise((resolve) => reservation.listen(0, '127.0.0.1', resolve));
  const { port } = reservation.address();
  await new Promise((resolve) => reservation.close(resolve));
  const child = spawn(
    executable,
    [`--user-data-dir=${userData}`, `--remote-debugging-port=${port}`],
    {
      env: environment,
      cwd: path.dirname(executable),
      windowsHide: true,
      stdio: 'ignore',
    },
  );
  desktop = { child };
  await once(child, 'spawn');
  const endpoint = `http://127.0.0.1:${port}`;
  await until(async () => {
    assert.equal(child.exitCode, null, 'Installed desktop exited before readiness');
    try {
      return (await fetch(`${endpoint}/json/version`, { signal: AbortSignal.timeout(1000) })).ok;
    } catch {
      return false;
    }
  });
  desktop.browser = await chromium.connectOverCDP(endpoint, { timeout: 45_000 });
  desktop.page = await until(
    () =>
      desktop.browser
        .contexts()[0]
        ?.pages()
        .find((page) => page.url().startsWith('file:')),
    120_000,
  );
  await desktop.page.getByRole('main').waitFor({ state: 'visible', timeout: 45_000 });
  desktop.readyAfterMs = Math.round(performance.now() - startedAt);
  await desktop.page.evaluate(
    await readFile(path.join(directory, 'client', 'client.iife.js'), 'utf8'),
  );
  assert.deepEqual(
    await desktop.page.evaluate(() => window.operationDiagnosticAcceptance.listAccounts()),
    [],
  );
  return desktop.page;
}

async function closeDesktop() {
  if (!desktop) {
    return;
  }
  const current = desktop;
  desktop = undefined;
  try {
    if (
      current.child.exitCode === null &&
      current.child.signalCode === null &&
      current.browser?.isConnected()
    ) {
      const closed = once(current.child, 'exit');
      const closing = current.browser.newBrowserCDPSession().then((session) => {
        void session.send('Browser.close').catch(() => undefined);
        return closed;
      });
      await Promise.race([
        closing,
        wait(40_000, undefined, { ref: false }).then(() => {
          throw new Error('Installed desktop shutdown timed out');
        }),
      ]);
      assert.equal(current.child.exitCode, 0);
    }
  } finally {
    if (current.child.pid && current.child.exitCode === null && current.child.signalCode === null) {
      const exited = once(current.child, 'exit');
      current.child.kill();
      await exited;
    }
    await current.browser?.close();
  }
}

async function checkLoginFeedback(page, mode) {
  await page.getByRole('button', { name: 'Add Account', exact: true }).click();
  const authorization = page.getByRole('dialog', { name: 'Add Google Account', exact: true });
  await authorization.getByRole('button', { name: 'Open Login Page', exact: true }).click();
  await page.getByText('Failed to add account', { exact: true }).waitFor({ state: 'visible' });
  await authorization.getByRole('button', { name: 'Close', exact: true }).last().click();
  await page.getByRole('button', { name: 'Details', exact: true }).last().click();
  const details = page.getByRole('dialog', { name: 'Error details', exact: true });
  await details.waitFor({ state: 'visible' });
  const text = [
    await details.innerText(),
    ...(await details
      .getByRole('textbox')
      .evaluateAll((inputs) => inputs.map((input) => input.value))),
  ].join('\n');
  assert(text.includes('google-login'));
  assert(text.includes('proxy-configuration-invalid'));
  const reference = text.match(
    /[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}/,
  )?.[0];
  assert(reference, 'The real notification details lost the operation reference');
  await page.screenshot({ path: path.join(directory, `${mode}-details.png`) });
  await details.press('Escape');
  return reference;
}

function runCli(args) {
  const result = spawnSync(
    path.join(resources, 'node', 'node.exe'),
    [path.join(resources, 'cli', 'main.cjs'), ...args],
    {
      env: environment,
      cwd: directory,
      windowsHide: true,
      encoding: 'utf8',
      timeout: 120_000,
      maxBuffer: 16_000,
    },
  );
  assert.equal(result.status, 0, 'Installed CLI lifecycle command failed');
}

async function checkCliHttpFailure() {
  let requests = 0;
  let forwardedRequests = 0;
  const sockets = new Set();
  const proxy = createServer((request, response) => {
    forwardedRequests += 1;
    request.resume();
    response.writeHead(502).end();
  });
  proxy.on('connect', (request, socket) => {
    assert.equal(request.url, 'oauth2.googleapis.com:443');
    requests += 1;
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    const body = JSON.stringify({
      error: 'temporarily_unavailable',
      error_description: 'controlled-private-response',
    });
    socket.end(
      'HTTP/1.1 503 Service Unavailable\r\nContent-Type: application/json\r\nContent-Length: ' +
        Buffer.byteLength(body) +
        '\r\nConnection: close\r\n\r\n' +
        body,
    );
  });
  await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  await seed('standalone-core', `http://127.0.0.1:${proxy.address().port}`);
  let output = '';
  let outputOverflow = false;
  const child = spawn(
    path.join(resources, 'node', 'node.exe'),
    [path.join(resources, 'cli', 'main.cjs'), 'account', 'login'],
    {
      env: environment,
      cwd: directory,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  for (const stream of [child.stdout, child.stderr]) {
    stream.on('data', (chunk) => {
      output = (output + chunk.toString()).slice(-128_000);
      if (output.length === 128_000) {
        outputOverflow = true;
        child.kill();
      }
    });
  }
  const exited = once(child, 'exit');
  try {
    const authorization = await until(() => {
      assert(!outputOverflow, 'Installed CLI output exceeds the acceptance bound');
      assert.equal(child.exitCode, null, 'Installed CLI exited before authorization');
      const match = output.match(/https:\/\/accounts\.google\.com\/[^\s]+/);
      return match ? new URL(match[0]) : null;
    }, 180_000);
    const callback = new URL(authorization.searchParams.get('redirect_uri'));
    assert.equal(callback.hostname, '127.0.0.1');
    callback.searchParams.set('state', authorization.searchParams.get('state'));
    callback.searchParams.set('code', 'controlled-private-authorization-code');
    assert.equal((await fetch(callback, { signal: AbortSignal.timeout(10_000) })).status, 200);
    await Promise.race([
      exited,
      wait(45_000, undefined, { ref: false }).then(() => {
        throw new Error('Installed CLI login did not finish');
      }),
    ]);
    assert(!outputOverflow, 'Installed CLI output exceeds the acceptance bound');
    assert.equal(child.exitCode, 1);
    assert(requests > 0, 'The controlled HTTPS CONNECT proxy was not used');
    assert.equal(forwardedRequests, 0, 'OAuth must not be forwarded outside the TLS tunnel');
    runCli(['service', 'stop']);
    assert.equal(await connection.probe(), null);
    const diagnostic = await readPackagedCliDiagnostic({ home, directory, output, fixture });
    assert(diagnostic);
    assert.equal(diagnostic.stage, 'token-exchange');
    assert.equal(diagnostic.reason, 'http-rejected');
    assert.equal(diagnostic.upstreamStatus, 503);
    assert.equal(diagnostic.upstreamCode, 'temporarily_unavailable');
    assert.deepEqual(diagnostic.http, {
      route: 'https-connect',
      destination: 'loopback',
      transport: 'unknown',
      responseFormat: 'json',
    });
    assert.equal(diagnostic.accountCommit, 'not-attempted');
    assert(output.includes(diagnostic.diagnosticId));
    assert(!fixture.formatOperationDiagnostic(diagnostic).includes('controlled-private'));
    observations.push({ runtime: 'packaged-cli', diagnostic });
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await exited;
    }
    for (const socket of sockets) {
      socket.destroy();
    }
    proxy.closeAllConnections();
    await new Promise((resolve) => proxy.close(resolve));
    runCli(['service', 'stop']);
  }
}

await writeFile(backup, loginSettings('snapshot', backup));
try {
  await build({
    configFile: false,
    logLevel: 'error',
    resolve: { alias: { '@': path.join(project, 'src') } },
    build: {
      ssr: true,
      outDir: path.join(directory, 'fixture'),
      emptyOutDir: false,
      sourcemap: false,
      rollupOptions: {
        input: 'scripts/acceptance/diagnostics/packaged-profile.ts',
        output: { format: 'cjs', entryFileNames: 'fixture.cjs' },
      },
    },
  });
  fixture = await import(pathToFileURL(path.join(directory, 'fixture', 'fixture.cjs')).href);
  connection = fixture.connection(home);
  await build({
    configFile: false,
    logLevel: 'error',
    resolve: { alias: { '@': path.join(project, 'src') } },
    build: {
      outDir: path.join(directory, 'client'),
      emptyOutDir: false,
      sourcemap: false,
      minify: false,
      lib: {
        entry: 'scripts/acceptance/diagnostics/packaged-client.ts',
        name: 'OperationAcceptance',
        formats: ['iife'],
        fileName: () => 'client.iife.js',
      },
    },
  });
  for (const mode of ['desktop-embedded', 'standalone-core']) {
    await seed(mode);
    const page = await launch();
    assert.equal((await connection.probe()).kind, mode === 'desktop-embedded' ? 'desktop' : 'core');
    const detailsReference = await checkLoginFeedback(page, mode);
    const login = {
      diagnostic: fixture.readFinalizedOperationDiagnostic(
        await page.evaluate(() => window.operationDiagnosticAcceptance.loginFailure()),
      ),
    };
    assert(login.diagnostic, 'The packaged login response lost its diagnostic');
    assert.equal(login.diagnostic.reason, 'proxy-configuration-invalid');
    assert.equal(login.diagnostic.accountCommit, 'not-attempted');
    const switched = {
      diagnostic: fixture.readFinalizedOperationDiagnostic(
        await page.evaluate(
          (id) => window.operationDiagnosticAcceptance.switchFailure(id),
          randomUUID(),
        ),
      ),
    };
    assert(switched.diagnostic, 'The packaged switch response lost its diagnostic');
    assert.equal(switched.diagnostic.stage, 'account-load');
    assert.equal(switched.diagnostic.reason, 'account-not-found');
    assert.notEqual(login.diagnostic.diagnosticId, switched.diagnostic.diagnosticId);
    assert.deepEqual(
      await page.evaluate(() => window.operationDiagnosticAcceptance.listAccounts()),
      [],
    );
    observations.push({
      runtime: mode,
      readyAfterMs: desktop.readyAfterMs,
      detailsReference,
      login: login.diagnostic,
      switch: switched.diagnostic,
    });
    await page.screenshot({ path: path.join(directory, `${mode}.png`) });
    await closeDesktop();
    assert.equal(await connection.probe(), null);
  }
  await checkCliHttpFailure();
  assert.equal(await connection.probe(), null);
  assert.deepEqual(
    await keyringSnapshot(),
    originalKeys,
    'Application master key slots must remain unchanged',
  );
} catch (error) {
  acceptanceError = error;
} finally {
  try {
    await closeDesktop();
  } catch (error) {
    recoveryErrors.push(error);
  }
  try {
    if (connection && (await connection.probe())?.kind === 'core') {
      runCli(['service', 'stop']);
    }
  } catch (error) {
    recoveryErrors.push(error);
  }
  try {
    loginSettings('restore', backup);
    assert.equal(loginSettings('snapshot', backup), (await readFile(backup, 'utf8')).trim());
    assert.deepEqual(await keyringSnapshot(), originalKeys);
  } catch (error) {
    recoveryErrors.push(error);
  }
  for (const profile of [home, userData]) {
    try {
      assert.equal(path.dirname(await realpath(profile)), await realpath(directory));
      await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch (error) {
      if (error.code !== 'ENOENT') {
        recoveryErrors.push(error);
      }
    }
  }
}
if (acceptanceError || recoveryErrors.length) {
  throw new AggregateError(
    [acceptanceError, ...recoveryErrors].filter(Boolean),
    `Installed operation acceptance or recovery failed; evidence: ${directory}`,
  );
}
await writeFile(
  path.join(directory, 'result.json'),
  JSON.stringify({ observations, keyringUnchanged: true, loginSettingsRestored: true }, null, 2),
);
process.stdout.write(
  JSON.stringify({
    directory,
    runtimes: observations.map((item) => item.runtime),
    keyringUnchanged: true,
  }) + '\n',
);
