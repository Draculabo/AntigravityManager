import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import { z } from 'zod';
import spawn from 'cross-spawn';
import { openTrafficMonitor, verifyTrafficMonitor } from './traffic-monitor.mjs';

const flags = new Set([
  'electron-bin',
  'client',
  'bin',
  'gateway',
  'profile-home',
  'output',
  'model',
  'opencode-major',
  'codex-approval',
  'claude-system-prompt',
  'claude-max-output-tokens',
  'timeout-ms',
  'multimodal-case',
  'thinking-protocol',
  'traffic-monitor',
  'task-report',
]);
const values = {};
for (let i = 2; i < process.argv.length; i += 2) {
  const flag = process.argv[i];
  if (!flag?.startsWith('--') || !flags.has(flag.slice(2)) || !process.argv[i + 1]) {
    throw new Error(`Invalid option: ${flag ?? '(missing)'}`);
  }
  values[flag.slice(2)] = process.argv[i + 1];
}
for (const required of ['electron-bin', 'gateway', 'profile-home', 'output']) {
  if (!values[required]) {
    throw new Error(`Missing --${required}`);
  }
}
assert.equal(
  [values.client, values['multimodal-case'], values['thinking-protocol']].filter(Boolean).length,
  1,
);
if (values['thinking-protocol']) {
  assert(['openai', 'anthropic', 'gemini'].includes(values['thinking-protocol']));
}
if (values['traffic-monitor'] && (values['traffic-monitor'] !== 'true' || !values.client)) {
  throw new Error('--traffic-monitor true requires an agent task');
}
if (values['task-report'] && values['traffic-monitor'] !== 'true') {
  throw new Error('--task-report requires --traffic-monitor true');
}
if (values.client) {
  assert(['claude', 'codex', 'opencode'].includes(values.client));
}
const executable = path.resolve(values['electron-bin']);
const profileHome = path.resolve(values['profile-home']);
const userData = path.join(profileHome, 'desktop-data');
const preferences = z
  .object({
    version: z.literal(1),
    preferences: z.object({ owner_mode: z.literal('desktop-embedded') }),
  })
  .parse(JSON.parse(await fs.readFile(path.join(userData, 'desktop-preferences.json'), 'utf8')));
assert.equal(preferences.preferences.owner_mode, 'desktop-embedded');

const environment = {
  ...process.env,
  HOME: profileHome,
  USERPROFILE: profileHome,
  APPDATA: path.join(profileHome, 'AppData', 'Roaming'),
  LOCALAPPDATA: path.join(profileHome, 'AppData', 'Local'),
};
delete environment.NODE_OPTIONS;
delete environment.NODE_PATH;
delete environment.ELECTRON_RUN_AS_NODE;

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
    // WSL acceptance environments cannot provide Chromium user namespaces.
    ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
  ],
  {
    cwd: path.dirname(executable),
    env: environment,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  },
);
let electronOutputBytes = 0;
let startupOutput = '';
for (const stream of [electron.stdout, electron.stderr]) {
  stream.on('data', (chunk) => {
    electronOutputBytes += chunk.length;
    startupOutput = (startupOutput + chunk).slice(-8000);
  });
}
await once(electron, 'spawn');
let browser;
let runnerCode = null;
let runnerOutput = '';
try {
  const endpoint = `http://127.0.0.1:${address.port}`;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (electron.exitCode !== null) {
      const startupFlags = {
        missingModule: /Cannot find module|ERR_MODULE_NOT_FOUND/.test(startupOutput),
        abiMismatch: /NODE_MODULE_VERSION|compiled against a different/.test(startupOutput),
        keyring: /keyring|master.?key|credential store/i.test(startupOutput),
        profileConflict:
          /already.*(?:running|owned)|profile.*(?:conflict|locked)|single.*instance/i.test(
            startupOutput,
          ),
        sandbox: /sandbox|namespace/i.test(startupOutput),
      };
      console.log(JSON.stringify({ startupFlags }));
      throw new Error(`Electron exited before readiness: ${electron.exitCode}`);
    }
    try {
      browser = await chromium.connectOverCDP(endpoint, { timeout: 1000 });
      break;
    } catch {
      await delay(400);
    }
  }
  if (!browser) {
    throw new Error('Electron control endpoint did not become ready');
  }
  let page;
  while (Date.now() < deadline) {
    page = browser
      .contexts()
      .flatMap((context) => context.pages())
      .find((candidate) => candidate.url().startsWith('file:'));
    if (page) {
      break;
    }
    await delay(400);
  }
  if (!page) {
    throw new Error('Electron renderer did not open');
  }
  await page.getByRole('main').waitFor({ state: 'visible', timeout: 30000 });
  const config = JSON.parse(
    await fs.readFile(path.join(profileHome, '.antigravity-agent', 'gui_config.json'), 'utf8'),
  );
  let gatewayReady = false;
  const gatewayDeadline = Date.now() + 30000;
  while (Date.now() < gatewayDeadline && electron.exitCode === null) {
    try {
      const response = await fetch(`${values.gateway}/v1/models`, {
        headers: { authorization: `Bearer ${config.proxy.api_key}` },
        signal: AbortSignal.timeout(2000),
      });
      if (response.ok) {
        gatewayReady = true;
        break;
      }
    } catch {
      // A renderer can finish loading while its gateway is still starting.
    }
    await delay(400);
  }
  assert(gatewayReady, 'Electron gateway did not become ready');
  if (values['traffic-monitor'] === 'true') {
    await openTrafficMonitor(page);
  }

  const runnerFile = values['thinking-protocol']
    ? 'scripts/acceptance/thinking/live-thinking-acceptance.mjs'
    : values['multimodal-case']
      ? 'scripts/acceptance/multimodal/live-multimodal-acceptance.mjs'
      : 'scripts/acceptance/agents/live-agent-acceptance.mjs';
  const runnerArgs = [
    path.resolve(runnerFile),
    values['thinking-protocol'] ? '--protocol' : values['multimodal-case'] ? '--case' : '--client',
    values['thinking-protocol'] ?? values['multimodal-case'] ?? values.client,
    '--owner',
    'electron',
    '--gateway',
    values.gateway,
    '--profile-home',
    profileHome,
    '--output',
    path.resolve(values.output),
  ];
  for (const optional of [
    'bin',
    'model',
    'opencode-major',
    'codex-approval',
    'claude-system-prompt',
    'claude-max-output-tokens',
    'timeout-ms',
  ]) {
    if (values[optional]) {
      runnerArgs.push(`--${optional}`, values[optional]);
    }
  }
  if (values['task-report']) {
    const completed = z
      .object({
        ownerDeclared: z.literal('electron'),
        client: z.string(),
        gateway: z.string(),
        verdict: z.object({ passed: z.boolean(), failures: z.array(z.string()) }),
        audit: z.object({ count: z.number() }),
        artifactBytes: z.number().nullable(),
      })
      .parse(JSON.parse(await fs.readFile(values['task-report'], 'utf8')));
    assert.equal(completed.client, values.client);
    assert.equal(completed.gateway, values.gateway);
    runnerCode = completed.verdict.passed ? 0 : 1;
    runnerOutput = JSON.stringify({
      reportPath: path.resolve(values['task-report']),
      passed: completed.verdict.passed,
      failures: completed.verdict.failures,
      requests: completed.audit.count,
      artifactBytes: completed.artifactBytes,
    });
  } else {
    const runner = spawn(process.execPath, runnerArgs, {
      cwd: path.resolve('.'),
      env: environment,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    for (const stream of [runner.stdout, runner.stderr]) {
      stream.on('data', (chunk) => {
        runnerOutput = (runnerOutput + chunk).slice(-1200);
      });
    }
    [runnerCode] = await once(runner, 'exit');
  }
  const runnerSummary =
    runnerOutput
      .trim()
      .split('\n')
      .reverse()
      .flatMap((line) => {
        try {
          const parsed = JSON.parse(line);
          return typeof parsed.reportPath === 'string'
            ? [
                {
                  reportPath: parsed.reportPath,
                  passed: parsed.passed,
                  failures: parsed.failures,
                  requests: parsed.requests,
                  inputTokens: parsed.inputTokens,
                  outputTokens: parsed.outputTokens,
                  artifactBytes: parsed.artifactBytes,
                  httpStatus: parsed.httpStatus,
                },
              ]
            : [];
        } catch {
          return [];
        }
      })[0] ?? null;
  let trafficMonitor = null;
  if (values['traffic-monitor'] === 'true') {
    assert(runnerSummary?.reportPath, 'Traffic Monitor requires a completed task report');
    try {
      trafficMonitor = await verifyTrafficMonitor({
        page,
        gateway: values.gateway,
        profileHome,
        reportPath: runnerSummary.reportPath,
      });
    } catch (error) {
      const step = /failed at ([a-zA-Z-]+)$/.exec(error.message)?.[1] ?? 'unknown';
      await fs.writeFile(
        path.join(path.dirname(runnerSummary.reportPath), 'traffic-ui-report.json'),
        JSON.stringify({
          schemaVersion: 1,
          platform: process.platform,
          client: values.client,
          passed: false,
          failure: 'traffic-ui-comparison-failed',
          step,
        }),
        { mode: 0o600 },
      );
      // Playwright assertion errors can contain account identifiers from rendered rows.
      throw new Error(`Traffic Monitor UI comparison failed at ${step}`);
    }
  }
  console.log(
    JSON.stringify({
      electronWindowReady: true,
      electronPid: electron.pid,
      runnerExitCode: runnerCode,
      runnerSummary,
      taskReportReused: Boolean(values['task-report']),
      runnerOutputBytes: runnerOutput.length,
      trafficMonitor,
    }),
  );
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
  }
  console.log(JSON.stringify({ electronExitCode: electron.exitCode, electronOutputBytes }));
}
if (runnerCode !== 0 || electron.exitCode !== 0) {
  process.exitCode = 1;
}
// CDP can leave a transport handle alive after Browser.close on Linux.
// The child has exited and all results have been printed at this point.
process.exit(process.exitCode ?? 0);
