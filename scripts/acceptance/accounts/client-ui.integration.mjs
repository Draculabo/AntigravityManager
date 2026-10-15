import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import spawn from 'cross-spawn';
import { chromium } from 'playwright';
import { verifyClientIdentity } from './client-ui.mjs';

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agm-client-ui-'));
const profile = path.join(directory, 'profile');
const application = path.join(directory, 'main.cjs');
const html = path.join(directory, 'index.html');
let child;
let browser;
try {
  await fs.writeFile(
    html,
    '<!doctype html><html><body><p>fixture@example.com</p><p id="state">Authenticating...</p></body></html>',
  );
  await fs.writeFile(
    application,
    `const { app, BrowserWindow } = require('electron');
app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false });
  await window.loadFile(${JSON.stringify(html)});
});
app.on('window-all-closed', () => app.quit());
`,
  );
  const executable = path.resolve(
    'node_modules/electron/dist',
    process.platform === 'win32' ? 'electron.exe' : 'electron',
  );
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  child = spawn(
    executable,
    [
      application,
      `--user-data-dir=${profile}`,
      '--remote-debugging-port=0',
      '--disable-gpu',
      ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
    ],
    { env: environment, windowsHide: true, stdio: 'ignore' },
  );
  const deadline = Date.now() + 30000;
  let port;
  while (Date.now() < deadline && !port) {
    try {
      port = Number(
        (await fs.readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0],
      );
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw error;
      }
      await delay(100);
    }
  }
  assert(port > 0 && port < 65536, 'Isolated fixture did not expose its debugging port');
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const page = browser.contexts().flatMap((context) => context.pages())[0];
  await page.waitForURL('file:**');
  await page.locator('#state').evaluate((element) => {
    element.textContent = 'Accept and continue';
  });
  const termsBlocked = await verifyClientIdentity(browser, 'fixture@example.com', async () => true);
  assert.equal(
    termsBlocked.clientIdentityConfirmed,
    false,
    'A signed-in account behind a required terms page must not pass official readiness',
  );
  assert.equal(termsBlocked.clientScreen.termsRequired, true);
  assert.equal(termsBlocked.clientVerification, 'credentials-and-window-only');
  const initializing = verifyClientIdentity(browser, 'fixture@example.com', async () => true);
  void initializing.catch(() => {});
  assert.equal(
    await Promise.race([initializing.then(() => 'completed'), delay(750).then(() => 'pending')]),
    'pending',
    'An initial terms screen must allow the official renderer to finish loading account state',
  );
  await page.locator('#state').evaluate((element) => {
    element.textContent = 'Ready';
  });
  assert.equal((await initializing).clientIdentityConfirmed, true);
  await page.locator('#state').evaluate((element) => {
    element.textContent = 'Authenticating...';
  });
  const verification = verifyClientIdentity(browser, 'fixture@example.com', async () => false);
  void verification.catch(() => {});
  const early = await Promise.race([
    verification.then(() => 'completed'),
    delay(750).then(() => 'pending'),
  ]);
  assert.equal(
    early,
    'pending',
    'A visible email must not pass while the official client is still authenticating',
  );
  await page.locator('#state').evaluate((element) => {
    element.textContent = 'Ready';
  });
  const result = await verification;
  assert.equal(result.clientIdentityConfirmed, true);
  assert.equal(result.clientIdentityVisible, true);
  assert.equal(result.clientSignedIn, false);
  await page.evaluate(() => {
    document.body.innerHTML = '<p>Loading</p>';
  });
  const delayedPanel = verifyClientIdentity(browser, 'fixture@example.com', async () => false);
  void delayedPanel.catch(() => {});
  await delay(750);
  await page.evaluate(() => {
    document.body.innerHTML = '<button>Settings</button>';
    document.querySelector('button').addEventListener('click', () => {
      document.body.innerHTML = '<p>fixture@example.com</p><p>Ready</p>';
    });
  });
  await page.getByText('fixture@example.com', { exact: true }).waitFor({
    state: 'visible',
    timeout: 3000,
  });
  assert.equal((await delayedPanel).clientIdentityConfirmed, true);
  let acceptance = { state: 'other-account', tosType: 'standard' };
  const persistence = verifyClientIdentity(browser, 'fixture@example.com', async () => true, {
    readTermsAcceptance: async () => acceptance,
  });
  void persistence.catch(() => {});
  assert.equal(
    await Promise.race([persistence.then(() => 'completed'), delay(750).then(() => 'pending')]),
    'pending',
    'A hidden terms page must not pass before the selected account acceptance reaches disk',
  );
  acceptance = { state: 'recorded', tosType: 'standard' };
  const persisted = await persistence;
  assert.equal(persisted.clientIdentityConfirmed, true);
  assert.deepEqual(persisted.clientTermsAcceptance, acceptance);
  console.log(
    JSON.stringify({
      platform: process.platform,
      status: 'passed',
      check: 'visible identity waits for authentication readiness',
      fixture: true,
    }),
  );
} finally {
  if (browser) {
    await browser
      .newBrowserCDPSession()
      .then((session) => session.send('Browser.close'))
      .catch(() => {});
    if (browser.isConnected()) {
      await Promise.race([browser.close().catch(() => {}), delay(2000)]);
    }
  }
  child?.kill();
  await delay(500);
  await fs.rm(directory, { recursive: true, force: true });
}
