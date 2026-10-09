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
import { readClientMatrixUpstream, clientUpstreamPasses } from './multi-client-upstream.mjs';
import { createMultiClientRelay } from './multi-client-relay.mjs';
import { invokeReadOnlyClient } from './multi-client-invocation.mjs';
import { clientEvidencePasses } from './multi-client-protocol.mjs';

const selected = z.enum(['all', 'codex', 'opencode', 'claude']).parse(process.argv[2] ?? 'all');
const root = process.cwd();
const workspace = fs.realpathSync.native(
  fs.mkdtempSync(path.join(os.tmpdir(), 'agm-client-matrix-')),
);
const controlDirectory = fs.mkdtempSync(path.resolve('out/schema-work-package/client-control-'));
const trace = randomUUID();
const release = `schema-clients-${new Date().toISOString().slice(0, 10)}-${randomUUID().slice(0, 8)}`;
const runtime = path.resolve('dist/.runtime', `${process.platform}-${process.arch}`, 'standalone');
const executable = path.join(runtime, 'node/node.exe');
const { config, reporting, preferencePath } = readLiveConfiguration(root);
const snapshots = [
  path.join(os.homedir(), '.antigravity-agent/gui_config.json'),
  preferencePath,
].map((file) => ({ file, bytes: fs.readFileSync(file) }));
const result = {
  release,
  selected,
  controlledRealClientSampling: true,
  organicTraffic: false,
  defaultEndpointConfiguration: true,
  successfulProviderResponsesSimulated: false,
  clients: [],
  restoredStopped: false,
};
let child;
let spawnFailed = false;
let management;
let relay;
const hasExited = () => spawnFailed || child.exitCode !== null || child.signalCode !== null;

await build({
  configFile: false,
  logLevel: 'error',
  resolve: { alias: { '@': path.resolve('src') } },
  build: {
    ssr: true,
    target: 'node22',
    outDir: controlDirectory,
    emptyOutDir: false,
    rollupOptions: {
      input: 'scripts/acceptance/schema/runtime-control.ts',
      output: { format: 'cjs', entryFileNames: 'control.cjs', exports: 'named' },
    },
  },
});
const control = createRequire(import.meta.url)(path.join(controlDirectory, 'control.cjs'));
const endpoint = control.getManagementEndpoint();
async function stopped() {
  if (await control.probeProfileOwner(control.getProfileOwnershipEndpoint())) {
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

try {
  if (!(await stopped())) {
    throw new Error('Profile is already owned');
  }
  const environment = {
    ...process.env,
    SENTRY_DSN: reporting.SENTRY_DSN,
    SENTRY_RELEASE: release,
    ANTIGRAVITY_DESKTOP_PREFERENCES_PATH: preferencePath,
  };
  delete environment.NODE_PATH;
  delete environment.NODE_OPTIONS;
  delete environment.ELECTRON_RUN_AS_NODE;
  child = spawn(executable, [path.join(runtime, 'core/main.cjs')], {
    cwd: runtime,
    env: environment,
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  child.once('error', () => {
    spawnFailed = true;
  });
  const unbound = new control.ManagementClient(endpoint);
  await waitForOwnedCore({
    management: {
      status: async () => {
        const status = await unbound.status();
        if (status.pid !== child.pid) {
          throw new Error('Unexpected profile owner');
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
  result.activeAccounts = (await rpc.gatewayStatus()).active_accounts;
  for (const client of selected === 'all' ? ['codex', 'opencode', 'claude'] : [selected]) {
    process.stdout.write(`${JSON.stringify({ stage: 'client-started', client })}\n`);
    const evidence = { client, passed: false, observations: [] };
    result.clients.push(evidence);
    const directory = path.join(workspace, client);
    fs.mkdirSync(directory);
    const marker = `client-read-${randomUUID()}`;
    fs.writeFileSync(path.join(directory, 'probe.txt'), marker, { mode: 0o600 });
    try {
      const mcpConfig =
        client === 'claude' ? await control.prepareClientMcpConfig(directory) : undefined;
      relay = await createMultiClientRelay({
        gateway: `http://127.0.0.1:${config.proxy.port}`,
        apiKey: config.proxy.api_key,
        client,
        trace,
        directory,
        marker,
        measureSchemas: control.measureClientSchemas,
      });
      Object.assign(
        evidence,
        await invokeReadOnlyClient({
          client,
          directory,
          baseUrl: relay.baseUrl,
          marker,
          mcpConfig,
        }),
      );
      evidence.observations = relay.observations;
      evidence.passed = clientEvidencePasses(evidence);
    } catch {
      evidence.failure = 'client-execution-or-forwarding-failed';
    } finally {
      if (relay) {
        await relay.close();
        relay = undefined;
      }
    }
    process.stdout.write(
      `${JSON.stringify({ stage: 'client-finished', client, passed: evidence.passed, exit: evidence.exit, finalMatched: evidence.finalMatched, requests: evidence.observations.length, schemas: Math.max(0, ...evidence.observations.map((item) => item.schemas.schemas)), blockedRequests: evidence.observations.filter((item) => item.blockedToolInstructions).length })}\n`,
    );
  }
} catch {
  result.failure = 'owned-core-or-gateway-startup-failed';
} finally {
  if (relay) {
    await relay.close();
  }
  if (management && child && !hasExited()) {
    try {
      await management.shutdown();
    } catch {
      result.shutdownRequestFailed = true;
    }
    for (let attempt = 0; attempt < 60 && !hasExited(); attempt++) {
      await delay(250);
    }
  }
  if (child && !hasExited()) {
    child.kill();
    result.forcedOwnedChildCleanup = true;
    for (let attempt = 0; attempt < 40 && !hasExited(); attempt++) {
      await delay(250);
    }
  }
  result.restoredStopped = (!child || hasExited()) && (await stopped());
  result.savedSettingsUnchanged = snapshots.every(({ file, bytes }) =>
    fs.readFileSync(file).equals(bytes),
  );
  try {
    const database = new DatabaseSync(
      path.join(os.homedir(), '.antigravity-agent/proxy-state/request-audit.db'),
      { readOnly: true },
    );
    try {
      result.upstreamRequests = readClientMatrixUpstream(database, trace);
    } finally {
      database.close();
    }
  } catch {
    result.auditEvidenceAvailable = false;
  }
  for (const client of result.clients) {
    const requests = result.upstreamRequests?.filter((item) => item.client === client.client) ?? [];
    client.actualUpstreamVerified = clientUpstreamPasses(requests, client.observations.length);
    client.passed &&= client.actualUpstreamVerified;
  }
  try {
    const resolved = path.resolve(workspace);
    if (
      path.dirname(resolved) === fs.realpathSync.native(os.tmpdir()) &&
      path.basename(resolved).startsWith('agm-client-matrix-')
    ) {
      fs.rmSync(resolved, { recursive: true });
      result.temporaryProfileCleanup = true;
    } else {
      result.temporaryProfileCleanup = false;
    }
  } catch {
    result.temporaryProfileCleanup = false;
  }
  result.allClientsPassed =
    result.clients.length === (selected === 'all' ? 3 : 1) &&
    result.clients.every((item) => item.passed) &&
    result.restoredStopped &&
    result.savedSettingsUnchanged &&
    result.temporaryProfileCleanup &&
    !result.forcedOwnedChildCleanup &&
    !result.shutdownRequestFailed;
  fs.writeFileSync(
    `artifacts/schema-work-package/live-results/${release}.json`,
    `${JSON.stringify(result, null, 2)}\n`,
  );
  process.stdout.write(
    `${JSON.stringify({ release, allClientsPassed: result.allClientsPassed, clients: result.clients.map(({ client, passed, finalMatched, actualUpstreamVerified }) => ({ client, passed, finalMatched, actualUpstreamVerified })), restoredStopped: result.restoredStopped, savedSettingsUnchanged: result.savedSettingsUnchanged, temporaryProfileCleanup: result.temporaryProfileCleanup })}\n`,
  );
  process.exitCode = result.allClientsPassed ? 0 : 1;
}
