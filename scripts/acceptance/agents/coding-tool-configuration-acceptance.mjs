import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import spawn from 'cross-spawn';
import { Command, Option } from 'commander';
import { chromium } from 'playwright';
import { parse as parseToml } from 'smol-toml';
import { parse as parseJsonc } from 'jsonc-parser';
import { z } from 'zod';
import { loginSettings } from '../helpers/windows-login-settings.mjs';

const values = new Command()
  .description('Verify packaged desktop coding-tool configuration in a prepared isolated profile.')
  .requiredOption('--electron-bin <path>', 'Packaged Electron executable')
  .requiredOption('--profile-home <path>', 'Prepared isolated profile')
  .requiredOption('--output <path>', 'Acceptance report directory')
  .addOption(
    new Option('--client <tool>', 'Coding tool').choices(['claude', 'codex']).makeOptionMandatory(),
  )
  .option('--bin <path>', 'Coding tool executable')
  .addOption(new Option('--live <enabled>', 'Run the TODO request SOP').choices(['true']))
  .option('--model-name <label>', 'Visible model label to select')
  .addOption(
    new Option('--codex-shell-profile <mode>', 'Explicit shell-startup diagnostic')
      .choices(['default', 'disabled'])
      .default('default'),
  )
  .parse()
  .opts();
const client = values.client;
const executable = path.resolve(values.electronBin);
const home = path.resolve(values.profileHome);
const output = path.resolve(values.output);
const userData = path.join(home, 'desktop-data');
const toolHome = path.join(home, 'coding-tools', client);
const settings = path.join(toolHome, client === 'codex' ? 'config.toml' : 'settings.json');
const title = client === 'codex' ? 'Codex' : 'Claude Code';
const config = z
  .object({ proxy: z.object({ port: z.number().int(), api_key: z.string().min(1) }) })
  .parse(
    JSON.parse(await fs.readFile(path.join(home, '.antigravity-agent/gui_config.json'), 'utf8')),
  );
const preferences = z
  .object({
    preferences: z.object({ owner_mode: z.literal('desktop-embedded'), language: z.literal('en') }),
  })
  .parse(JSON.parse(await fs.readFile(path.join(userData, 'desktop-preferences.json'), 'utf8')));
assert(preferences.preferences.owner_mode === 'desktop-embedded');
// Prepared isolated profiles are required. Never replace an existing tool file for acceptance.
await assert.rejects(fs.access(settings), { code: 'ENOENT' });
await fs.mkdir(output, { recursive: true, mode: 0o700 });
const environment = {
  ...process.env,
  HOME: home,
  USERPROFILE: home,
  APPDATA: path.join(home, 'AppData/Roaming'),
  LOCALAPPDATA: path.join(home, 'AppData/Local'),
  CODEX_HOME: path.join(home, 'coding-tools/codex'),
  CLAUDE_CONFIG_DIR: path.join(home, 'coding-tools/claude'),
};
for (const name of ['NODE_OPTIONS', 'NODE_PATH', 'ELECTRON_RUN_AS_NODE']) delete environment[name];
const loginBackup = path.join(output, 'login-settings.private.json');
if (process.platform === 'win32')
  await fs.writeFile(loginBackup, loginSettings('snapshot', loginBackup), { mode: 0o600 });
const reservation = net.createServer();
const listening = once(reservation, 'listening');
reservation.listen(0, '127.0.0.1');
await listening;
const address = reservation.address();
assert(address && typeof address !== 'string');
const closed = once(reservation, 'close');
reservation.close();
await closed;
const electron = spawn(
  executable,
  [
    `--user-data-dir=${userData}`,
    `--remote-debugging-port=${address.port}`,
    ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
  ],
  {
    cwd: path.dirname(executable),
    env: environment,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  },
);
let outputBytes = 0;
const signatureRecovery = { triggered: 0, failed: 0 };
for (const stream of [electron.stdout, electron.stderr]) {
  let pendingLine = '';
  stream.on('data', (chunk) => {
    outputBytes += chunk.length;
    const lines = (pendingLine + chunk.toString()).split('\n');
    pendingLine = lines.pop().slice(-2048);
    for (const line of lines) {
      if (line.includes('Invalid thought signature recovery triggered:')) {
        signatureRecovery.triggered += 1;
      }
      if (line.includes('Invalid thought signature recovery failed:')) {
        signatureRecovery.failed += 1;
      }
    }
  });
}
let browser;
let passed = false;
let recovered = false;
let step = 'startup';
let taskSummary = null;
try {
  await once(electron, 'spawn');
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    assert(electron.exitCode === null, 'Electron exited before readiness');
    try {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${address.port}`, {
        timeout: 1000,
      });
      break;
    } catch {
      await delay(300);
    }
  }
  assert(browser, 'Electron control endpoint was not ready');
  let page;
  while (Date.now() < deadline) {
    page = browser
      .contexts()
      .flatMap((context) => context.pages())
      .find((page) => page.url().startsWith('file:'));
    if (page) break;
    await delay(300);
  }
  assert(page, 'Electron renderer was not ready');
  await page.getByRole('main').waitFor({ state: 'visible', timeout: 30000 });
  await page.locator('a[href="/proxy"]').first().click();
  await page.getByText('Connect your coding tools', { exact: true }).waitFor({ state: 'visible' });
  const card = page.getByText(title, { exact: true }).locator('..').locator('..');
  const configure = card.getByRole('button', { name: 'Configure', exact: true });
  await configure.waitFor({ state: 'visible' });
  await configure.click();
  const dialog = page.getByRole('dialog');
  step = 'configure';
  if (values.modelName) {
    step = 'model-selection';
    await dialog.getByRole('combobox').click();
    // Provider aliases can share display names; the written model ID is checked below.
    await page.getByRole('option', { name: values.modelName, exact: true }).first().click();
  }
  step = 'confirm-configuration';
  await dialog.getByRole('button', { name: 'Confirm', exact: true }).click();
  await dialog.waitFor({ state: 'hidden', timeout: 30000 });
  step = 'verify-configuration';
  await card.getByText('Configuration saved', { exact: true }).waitFor({ state: 'visible' });
  await card.getByText('Requests not verified', { exact: true }).waitFor({ state: 'visible' });
  const source = await fs.readFile(settings, 'utf8');
  const root = client === 'codex' ? parseToml(source) : parseJsonc(source);
  const model = z.string().min(1).parse(root.model);
  const connection = client === 'codex' ? root.model_providers?.antigravity_manager : root.env;
  assert(connection, 'Tool connection was not written');
  assert.equal(
    client === 'codex' ? connection.base_url : connection.ANTHROPIC_BASE_URL,
    `http://localhost:${config.proxy.port}${client === 'codex' ? '/v1' : ''}`,
  );
  assert.equal(
    client === 'codex' ? connection.http_headers?.Authorization : connection.ANTHROPIC_API_KEY,
    `${client === 'codex' ? 'Bearer ' : ''}${config.proxy.api_key}`,
  );
  step = 'preview';
  await card.getByRole('button', { name: 'View configuration', exact: true }).click();
  step = 'preview-content';
  await dialog.locator('pre').filter({ hasText: '[REDACTED]' }).waitFor({ state: 'visible' });
  assert(
    !(await dialog.innerText()).includes(config.proxy.api_key),
    'Preview exposed the connection key',
  );
  step = 'preview-close';
  await dialog.getByRole('button', { name: 'Close', exact: true }).first().click();
  // Only tool cards are captured; other proxy panels can contain private connection examples.
  await card.locator('..').screenshot({ path: path.join(output, `${client}-configuration.png`) });
  if (values.live === 'true') {
    step = 'live-task';
    const runner = spawn(
      process.execPath,
      [
        path.resolve('scripts/acceptance/agents/live-agent-acceptance.mjs'),
        '--client',
        client,
        '--owner',
        'electron',
        '--gateway',
        `http://127.0.0.1:${config.proxy.port}`,
        '--profile-home',
        home,
        '--output',
        output,
        '--model',
        model,
        '--client-settings',
        toolHome,
        '--timeout-ms',
        '240000',
        '--codex-shell-profile',
        values.codexShellProfile,
        ...(values.bin ? ['--bin', values.bin] : []),
      ],
      { env: environment, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let runnerOutput = '';
    for (const stream of [runner.stdout, runner.stderr])
      stream.on('data', (chunk) => {
        runnerOutput = (runnerOutput + chunk).slice(-4000);
      });
    const [code] = await once(runner, 'exit');
    for (const line of runnerOutput.trim().split('\n').reverse()) {
      try {
        const value = JSON.parse(line);
        if (typeof value.reportPath === 'string') {
          taskSummary = value;
          break;
        }
      } catch {
        // Other stdout lines are not structured task reports.
      }
    }
    assert.equal(code, 0, 'Generated-configuration TODO task failed');
    assert(taskSummary?.passed, 'A successful task report was not produced');
  }
  step = 'remove';
  await card.getByRole('button', { name: 'Remove connection', exact: true }).click();
  await dialog.getByRole('button', { name: 'Confirm', exact: true }).click();
  await dialog.waitFor({ state: 'hidden', timeout: 30000 });
  await card.getByText('Not configured', { exact: true }).waitFor({ state: 'visible' });
  const removed = await fs.readFile(settings, 'utf8');
  assert(!removed.includes(config.proxy.api_key), 'Connection key was retained after removal');
  step = 'restore';
  await card.getByRole('button', { name: 'Restore backup', exact: true }).click();
  await dialog.getByRole('button', { name: 'Confirm', exact: true }).click();
  await dialog.waitFor({ state: 'hidden', timeout: 30000 });
  await assert.rejects(fs.access(settings), { code: 'ENOENT' });
  await assert.rejects(fs.access(`${settings}.antigravity-manager.bak`), { code: 'ENOENT' });
  recovered = true;
  passed = true;
} catch {
  // UI assertions can include account text; only the bounded step is reported.
  console.error(`Coding tool acceptance failed at ${step}`);
} finally {
  if (browser && electron.exitCode === null) {
    const exited = once(electron, 'exit');
    const session = await browser.newBrowserCDPSession();
    await session.send('Browser.close').catch(() => undefined);
    await Promise.race([exited, delay(40000)]);
  }
  await browser?.close().catch(() => undefined);
  if (electron.exitCode === null) {
    electron.kill();
    passed = false;
  }
  if (process.platform === 'win32') loginSettings('restore', loginBackup);
  const report = {
    schemaVersion: 1,
    platform: process.platform,
    client,
    owner: 'desktop-embedded',
    passed: passed && electron.exitCode === 0,
    recovered,
    step,
    taskSummary,
    electronExitCode: electron.exitCode,
    electronOutputBytes: outputBytes,
    signatureRecovery,
  };
  await fs.writeFile(
    path.join(output, `${client}-ui-report.json`),
    JSON.stringify(report, null, 2),
    { mode: 0o600 },
  );
  console.log(JSON.stringify(report));
  process.exit(report.passed ? 0 : 1);
}
