import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import { build } from 'vite';
import { z } from 'zod';
import { readLiveConfiguration } from './live-configuration.mjs';
import { waitForOwnedCore } from './live-startup.mjs';
import { verifyLiveToolHistory } from './live-tool-history.mjs';
import { createLiveRetryRelay } from './live-retry-relay.mjs';
import { readLiveRetryEvidence, retryEvidencePasses } from './live-retry-evidence.mjs';

// Keep fault injection/restoration independent from the Schema/Sentry receipt acceptance gate.
const selected = z
  .enum(['network', 'rotation', 'incomplete', 'all'])
  .parse(process.argv[2] ?? 'all');
const model = z
  .enum(['gemini-3.7-flash-high', 'gemini-3.1-pro-high'])
  .parse(process.argv[3] ?? 'gemini-3.7-flash-high');
const root = process.cwd();
const workspace = fs.mkdtempSync(path.resolve('out/schema-work-package/live-retry-'));
const runtime = path.resolve('dist/.runtime', `${process.platform}-${process.arch}`, 'standalone');
const executable = path.join(runtime, process.platform === 'win32' ? 'node/node.exe' : 'node/node');
const { config, reporting, preferencePath } = readLiveConfiguration(root);
const configPath = path.join(os.homedir(), '.antigravity-agent/gui_config.json');
const snapshots = [configPath, preferencePath].map((file) => ({
  file,
  bytes: fs.readFileSync(file),
}));
const trace = randomUUID();
const release = `schema-retry-${new Date().toISOString().slice(0, 10)}-${randomUUID().slice(0, 8)}`;
const result = {
  release,
  model,
  selected,
  productionRuntime: true,
  transientEndpointRelay: true,
  successfulProviderResponsesSimulated: false,
  controlledIncompleteResponseInjected: selected === 'incomplete',
  scenarios: [],
  calls: [],
  restoredStopped: false,
};
let child;
let spawnFailed = false;
let management;
let relay;
let startupOutput = '';
const hasExited = () => spawnFailed || child.exitCode !== null || child.signalCode !== null;

await build({
  configFile: false,
  logLevel: 'error',
  resolve: { alias: { '@': path.resolve('src') } },
  build: {
    ssr: true,
    target: 'node22',
    outDir: workspace,
    emptyOutDir: false,
    rollupOptions: {
      input: 'scripts/acceptance/schema/runtime-control.ts',
      output: { format: 'cjs', entryFileNames: 'control.cjs', exports: 'named' },
    },
  },
});
const control = createRequire(import.meta.url)(path.join(workspace, 'control.cjs'));
const endpoint = control.getManagementEndpoint();
const ownerEndpoint = control.getProfileOwnershipEndpoint();

async function stopped() {
  if (await control.probeProfileOwner(ownerEndpoint)) {
    return false;
  }
  try {
    await new control.ManagementClient(endpoint).status();
    return false;
  } catch (error) {
    if (error.name !== 'ServiceNotRunningError') {
      throw error;
    }
    return true;
  }
}

async function http(mode, scenario, route, body, label) {
  const faulted =
    mode === 'incomplete' ? label === 'history-parallel-call' : label === 'history-combined-result';
  if (faulted) {
    relay.arm(mode, path.basename(workspace));
  }
  process.stdout.write(`${JSON.stringify({ mode, label })}\n`);
  try {
    const response = await fetch(`http://127.0.0.1:${config.proxy.port}${route}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-schema-acceptance': `${trace}:${mode}:${label}`,
        ...(config.proxy.api_key ? { authorization: `Bearer ${config.proxy.api_key}` } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });
    result.calls.push({ mode, label, status: response.status });
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body ?? []) {
      size += chunk.length;
      if (size > 1_048_576) {
        throw new Error('Controlled gateway response is oversized');
      }
      chunks.push(Buffer.from(chunk));
    }
    const text = Buffer.concat(chunks).toString('utf8');
    if (!response.ok) {
      throw new Error('Controlled gateway request failed');
    }
    return JSON.parse(text);
  } finally {
    if (faulted) {
      scenario.relayObservations = relay.disarm();
    }
  }
}

try {
  if (!(await stopped())) {
    throw new Error('Profile is already owned');
  }
  relay = await createLiveRetryRelay();
  const environment = {
    ...process.env,
    SENTRY_DSN: reporting.SENTRY_DSN,
    SENTRY_RELEASE: release,
    ANTIGRAVITY_DESKTOP_PREFERENCES_PATH: preferencePath,
    PROXY_INTERNAL_BASE_URLS: relay.baseUrls,
  };
  delete environment.NODE_PATH;
  delete environment.NODE_OPTIONS;
  delete environment.ELECTRON_RUN_AS_NODE;
  child = spawn(executable, [path.join(runtime, 'core/main.cjs')], {
    cwd: runtime,
    env: environment,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.once('error', () => {
    spawnFailed = true;
  });
  const observe = (chunk) => {
    if (startupOutput.length < 16_384) {
      startupOutput += chunk.toString('utf8').slice(0, 16_384 - startupOutput.length);
    }
  };
  child.stdout.on('data', observe);
  child.stderr.on('data', observe);
  const unbound = new control.ManagementClient(endpoint);
  await waitForOwnedCore({
    management: {
      status: async () => {
        const status = await unbound.status();
        if (status.pid !== child.pid) {
          throw new Error('Unexpected core owner');
        }
        return status;
      },
    },
    childHasExited: hasExited,
    result,
  });
  const handshake = await unbound.handshake();
  management = new control.ManagementClient(endpoint, undefined, handshake.epoch);
  const rpc = new control.CoreRpcClient(endpoint, undefined, handshake.epoch);
  const started = await rpc.startGateway(config.proxy.port);
  if (!started.success) {
    throw new Error('Gateway startup failed');
  }
  const status = await rpc.gatewayStatus();
  result.activeAccounts = status.active_accounts;
  for (const mode of selected === 'all' ? ['network', 'rotation'] : [selected]) {
    const scenario = { mode, passed: false };
    result.scenarios.push(scenario);
    const probeWorkspace = path.join(workspace, mode);
    fs.mkdirSync(probeWorkspace);
    try {
      await verifyLiveToolHistory({
        http: (route, body, label) => http(mode, scenario, route, body, label),
        workspace: probeWorkspace,
        model,
        result: scenario,
      });
      scenario.historyResultsMatched = true;
    } catch {
      scenario.failure = 'tool-history-or-gateway-request-failed';
      process.exitCode = 1;
    }
  }
} catch {
  result.failure = 'profile-startup-or-gateway-failed';
  process.exitCode = 1;
} finally {
  if (management && child && !hasExited()) {
    try {
      await management.shutdown();
    } catch {
      result.shutdownRequestFailed = true;
      process.exitCode = 1;
    }
    for (let probe = 0; probe < 60 && !hasExited(); probe++) {
      await delay(250);
    }
  }
  if (child && !hasExited()) {
    child.kill();
    result.forcedOwnedChildCleanup = true;
    process.exitCode = 1;
    for (let probe = 0; probe < 40 && !hasExited(); probe++) {
      await delay(250);
    }
  }
  result.restoredStopped = (!child || hasExited()) && (await stopped());
  result.savedSettingsUnchanged = snapshots.every(({ file, bytes }) =>
    fs.readFileSync(file).equals(bytes),
  );
  result.startupSignals = {
    coreStartedLogged: startupOutput.includes('Standalone core service started'),
    missingModule: /Cannot find module|ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND/.test(startupOutput),
    nativeFailure: /NODE_MODULE_VERSION|did not self-register|was compiled against/.test(
      startupOutput,
    ),
  };
  startupOutput = '';
  if (relay) {
    await relay.close();
  }
  try {
    const database = new DatabaseSync(
      path.join(os.homedir(), '.antigravity-agent/proxy-state/request-audit.db'),
      { readOnly: true },
    );
    try {
      for (const scenario of result.scenarios) {
        scenario.audit = readLiveRetryEvidence(database, trace, scenario.mode);
        scenario.initialAudit = readLiveRetryEvidence(
          database,
          trace,
          scenario.mode,
          'history-parallel-call',
        );
        const observations = scenario.relayObservations ?? [];
        const injected =
          scenario.mode === 'network'
            ? ['socket-reset', 'forwarded']
            : scenario.mode === 'incomplete'
              ? ['injected-incomplete-thinking', 'forwarded']
              : ['injected-503', 'injected-503', 'forwarded'];
        scenario.passed =
          scenario.historyResultsMatched === true &&
          retryEvidencePasses(
            scenario.mode,
            scenario.mode === 'incomplete' ? scenario.initialAudit : scenario.audit,
          ) &&
          JSON.stringify(observations.map((item) => item.action)) === JSON.stringify(injected) &&
          observations.every((item) => item.contentsUnchanged === true) &&
          observations.at(-1)?.status === 200;
      }
    } finally {
      database.close();
    }
  } catch {
    result.auditEvidenceAvailable = false;
    process.exitCode = 1;
  }
  result.allScenariosPassed =
    result.scenarios.length === (selected === 'all' ? 2 : 1) &&
    result.scenarios.every((scenario) => scenario.passed) &&
    result.restoredStopped &&
    result.savedSettingsUnchanged &&
    !result.forcedOwnedChildCleanup &&
    !result.shutdownRequestFailed;
  if (!result.allScenariosPassed) {
    process.exitCode = 1;
  }
  fs.writeFileSync(
    `artifacts/schema-work-package/live-results/${release}.json`,
    `${JSON.stringify(result, null, 2)}\n`,
  );
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
