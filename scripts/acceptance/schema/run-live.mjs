import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createLiveSentryReader } from './live-sentry-query.mjs';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import { build } from 'vite';
import { z } from 'zod';
import { format } from 'prettier';
import { createRemoteSentryRelay } from './remote-sentry-relay.mjs';
import { createLiveToolChecks } from './live-tool-cycles.mjs';
import { runLiveCodingClient } from './live-coding-client.mjs';
import { readLiveLocalDiagnostics } from './live-local-diagnostics.mjs';
import { verifyLiveToolHistory } from './live-tool-history.mjs';
import { readLiveConfiguration } from './live-configuration.mjs';
import {
  readLiveUpstreamEvidence,
  hasVerifiedSignatureRecovery,
} from './live-upstream-evidence.mjs';
import { waitForOwnedCore } from './live-startup.mjs';

const root = process.cwd();
const sessionStartedAt = Date.now();
const openAIModel = z
  .enum(['gemini-3-flash', 'gemini-3.7-flash-high', 'gemini-3.1-pro-high'])
  .parse(process.argv[2] ?? 'gemini-3.7-flash-high');
const experimentalProductionEndpoint = process.argv[3] === 'production';
const clientOnly = ['client', 'client-mcp'].includes(process.argv[3]);
const configuredClient = process.argv[3] === 'client-mcp';
const historyOnly = process.argv[3] === 'history';
const historyVariant = historyOnly
  ? z.enum(['extended', 'recovery']).optional().parse(process.argv[4])
  : undefined;
const extendedHistory = historyVariant === 'extended';
const experimentalUserAgentVersion =
  process.argv[3] && !experimentalProductionEndpoint && !clientOnly && !historyOnly
    ? z.enum(['2.5.5', '1.23.2']).parse(process.argv[3])
    : undefined;
const release = `schema-live-${new Date().toISOString().slice(0, 10)}-${randomUUID().slice(0, 8)}`;
const workspace = fs.mkdtempSync(path.resolve('out/schema-work-package/live-'));
const progressFile = path.resolve('out/schema-work-package/live-progress.json');
const result = {
  release,
  openAIModel,
  clientOnly,
  historyOnly,
  extendedHistory,
  experimentalUserAgentVersion,
  experimentalProductionEndpoint,
  productionRuntime: !experimentalUserAgentVersion,
  defaultEndpointConfiguration: !experimentalProductionEndpoint,
  stages: [],
  calls: [],
  sentry: { readAvailable: false, received: false },
  restoredStopped: false,
};
const progress = (stage) => {
  result.stages.push(stage);
  fs.writeFileSync(progressFile, JSON.stringify({ ...result, stage }), { mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ stage })}\n`);
};
const { config, reporting, preferences, preferencePath } = readLiveConfiguration(root);
const sentryRead = createLiveSentryReader(reporting);
const runtime = path.resolve('dist/.runtime', `${process.platform}-${process.arch}`, 'standalone');
const executable = path.join(runtime, process.platform === 'win32' ? 'node/node.exe' : 'node/node');
const probePath = path.join(workspace, 'probe.txt');
const marker = `gateway-read-${randomUUID()}`;
fs.writeFileSync(probePath, marker, { mode: 0o600 });
let child;
const childHasExited = () => child.exitCode !== null || child.signalCode !== null;
let management;
let rpc;
let epoch;
let started = false;
let sentryRelay;
let startupOutput = '';
let clientOptions = {};
const tracePrefix = randomUUID();
const baseUrl = `http://127.0.0.1:${config.proxy.port}`;

async function http(route, body, label, expectedStatus = 200) {
  progress(`request:${label}`);
  const response = await fetch(`${baseUrl}${route}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-schema-acceptance': `${tracePrefix}:${label}`,
      ...(config.proxy.api_key ? { authorization: `Bearer ${config.proxy.api_key}` } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });
  const text = await response.text();
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error('Gateway response was not JSON');
  }
  const metadata = { label, status: response.status };
  result.calls.push(metadata);
  if (response.status === expectedStatus && expectedStatus === 400) {
    const error = z
      .object({ error: z.object({ type: z.literal('invalid_request_error') }) })
      .parse(value);
    metadata.errorType = error.error.type;
    return value;
  }
  if (!response.ok) {
    const error = z
      .object({ error: z.object({ type: z.string().optional(), message: z.string() }) })
      .safeParse(value);
    metadata.errorType = error.success ? error.data.error.type : 'unknown';
    metadata.category =
      error.success && /accounts|quota|rate limit/i.test(error.data.error.message)
        ? 'account-availability'
        : 'gateway-or-upstream-error';
    throw new Error(`Live request failed: ${label} status=${response.status}`);
  }
  return value;
}

const { openAI, gemini } = createLiveToolChecks({ http, probePath, marker, result });
const codingClient = () =>
  runLiveCodingClient({
    workspace,
    marker,
    baseUrl,
    config,
    progress,
    result,
    tracePrefix,
    ...clientOptions,
  });

try {
  progress('checking-sentry-read-access');
  const access = sentryRead('list-issues', [
    '--environment',
    'production',
    '--time-range',
    '24h',
    '--limit',
    '1',
    '--query',
    `release:"${release}"`,
  ]);
  result.sentry.readAvailable = access.ok;
  if (!access.ok) {
    result.sentry.readHttpStatus = access.httpStatus;
  }
  progress('building-runtime-controller');
  if (!experimentalUserAgentVersion && !experimentalProductionEndpoint) {
    sentryRelay = await createRemoteSentryRelay(reporting.SENTRY_DSN);
  }
  const controlDirectory = fs.mkdtempSync(path.join(workspace, 'control-'));
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
  if (configuredClient) {
    clientOptions = {
      mcpConfig: await control.prepareClientMcpConfig(workspace),
      measureSchemas: control.measureClientSchemas,
    };
  }
  const owner = await control.probeProfileOwner(control.getProfileOwnershipEndpoint());
  if (owner) {
    throw new Error(`Profile is already owned by ${owner.kind}; live test will not replace it`);
  }
  if (!preferences.preferences.error_reporting_enabled) {
    throw new Error('Saved reporting preference is disabled');
  }
  progress('starting-owned-core');
  let coreEntry = path.join(runtime, 'core/main.cjs');
  if (experimentalUserAgentVersion) {
    progress('building-isolated-user-agent-experiment');
    const candidateRoot = path.join(workspace, 'candidate');
    const candidateCore = path.join(candidateRoot, 'core');
    fs.mkdirSync(candidateRoot, { recursive: true });
    fs.symlinkSync(
      path.join(runtime, 'node_modules'),
      path.join(candidateRoot, 'node_modules'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const original =
      'export async function resolveRequestUserAgent(): Promise<string> {\n  return await getResolvedDefaultRequestUserAgent();\n}';
    let replaced = false;
    await build({
      configFile: path.resolve('vite.core.config.mts'),
      logLevel: 'error',
      plugins: [
        {
          name: 'isolated-live-user-agent-experiment',
          enforce: 'pre',
          transform(code, id) {
            if (!id.replaceAll('\\', '/').endsWith('/server/common/utils/request-user-agent.ts')) {
              return;
            }
            const normalized = code.replaceAll('\r\n', '\n');
            if (!normalized.includes(original)) {
              throw new Error('User-Agent experiment seam changed');
            }
            replaced = true;
            return normalized.replace(
              original,
              `export async function resolveRequestUserAgent(): Promise<string> { return buildUserAgent(${JSON.stringify(experimentalUserAgentVersion)}); }`,
            );
          },
        },
      ],
      build: { outDir: candidateCore, emptyOutDir: false },
    });
    if (!replaced) {
      throw new Error('User-Agent experiment seam was not applied');
    }
    coreEntry = path.join(candidateCore, 'main.cjs');
  }
  const environment = {
    ...process.env,
    SENTRY_DSN: sentryRelay?.dsn ?? reporting.SENTRY_DSN,
    SENTRY_RELEASE: release,
    ANTIGRAVITY_DESKTOP_PREFERENCES_PATH: preferencePath,
  };
  if (experimentalProductionEndpoint) {
    environment.PROXY_INTERNAL_BASE_URLS = 'https://cloudcode-pa.googleapis.com/v1internal';
  }
  delete environment.NODE_PATH;
  delete environment.NODE_OPTIONS;
  delete environment.ELECTRON_RUN_AS_NODE;
  child = spawn(executable, [coreEntry], {
    cwd: runtime,
    env: environment,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const observeStartup = (chunk) => {
    if (!result.stages.includes('gateway-ready') && startupOutput.length < 16_384) {
      startupOutput += chunk.toString('utf8').slice(0, 16_384 - startupOutput.length);
    }
  };
  child.stdout.on('data', observeStartup);
  child.stderr.on('data', observeStartup);
  started = true;
  management = new control.ManagementClient(control.getManagementEndpoint());
  await waitForOwnedCore({ management, childHasExited, result });
  const handshake = await management.handshake();
  epoch = handshake.epoch;
  management = new control.ManagementClient(control.getManagementEndpoint(), undefined, epoch);
  rpc = new control.CoreRpcClient(control.getManagementEndpoint(), undefined, epoch);
  const start = await rpc.startGateway(config.proxy.port);
  if (!start.success) {
    throw new Error('Gateway could not start on the configured port');
  }
  const status = await rpc.gatewayStatus();
  result.activeAccounts = status.active_accounts;
  progress('gateway-ready');
  await http(
    '/v1/chat/completions',
    {
      model: 'gemini-3-flash',
      messages: [{ role: 'user', content: 'Controlled local Schema rejection probe.' }],
      tools: [
        {
          type: 'function',
          function: { name: 'probe_read', parameters: { $ref: 'https://invalid.example/schema' } },
        },
      ],
      stream: false,
    },
    'schema-local-rejection',
    400,
  );
  result.schemaLocalRejectionVerified = true;
  result.cycleFailures = [];
  const cycles =
    clientOnly || historyOnly
      ? []
      : experimentalProductionEndpoint
        ? [['openai-normal', () => openAI(openAIModel)]]
        : [
            ['openai-normal', () => openAI(openAIModel)],
            ['openai-degraded', () => openAI(openAIModel, true)],
            ['gemini-flash-current', () => gemini('gemini-3.7-flash-high', 'gemini-flash-current')],
            ['gemini-pro-preview', () => gemini('gemini-3.1-pro-preview', 'gemini-pro-preview')],
          ];
  for (const [label, execute] of cycles) {
    try {
      await execute();
    } catch (error) {
      result.cycleFailures.push({
        label,
        reason:
          error instanceof Error &&
          /^(Live request failed:|Upstream did not|Tool call escaped|OpenAI tool result|Gemini tool result)/.test(
            error.message,
          )
            ? error.message
            : 'Tool cycle failed validation',
      });
      process.exitCode = 1;
    }
  }
  if (
    !historyOnly &&
    !experimentalUserAgentVersion &&
    !experimentalProductionEndpoint &&
    openAIModel === 'gemini-3.1-pro-high'
  ) {
    await codingClient();
  }
  if (historyOnly) {
    await verifyLiveToolHistory({
      http,
      workspace,
      model: openAIModel,
      result,
      extended: extendedHistory,
      recovery: historyVariant === 'recovery',
    });
  }
  progress('tool-cycles-complete');
} catch (error) {
  result.startupDiagnostics = {
    startupOutputBytes: Buffer.byteLength(startupOutput),
    coreStartedLogged: startupOutput.includes('Standalone core service started'),
    startupFailureLogged: startupOutput.includes('Standalone core service failed to start'),
    missingModule: /Cannot find module|ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND/.test(startupOutput),
    missingResource: /ENOENT|worker resource/.test(startupOutput),
    nativeFailure: /NODE_MODULE_VERSION|did not self-register|was compiled against/.test(
      startupOutput,
    ),
    errorCodes: [
      ...new Set(
        startupOutput.match(
          /\b(?:MODULE_NOT_FOUND|ERR_[A-Z_]+|ENOENT|EADDRINUSE|SQLITE_[A-Z_]+)\b/g,
        ) ?? [],
      ),
    ],
  };
  if (error instanceof Error && /User-Agent experiment seam/.test(error.message)) {
    result.experimentBuildFailure = 'user-agent-seam';
  }
  result.failure =
    error instanceof Error &&
    /^(Live request failed:|Profile is already owned by|Saved reporting preference|Owned core|Gateway could not|Upstream did not|Tool call escaped|OpenAI tool result|Gemini tool result)/.test(
      error.message,
    )
      ? error.message
      : 'Live verification failed at the recorded stage';
  process.exitCode = 1;
} finally {
  if (!started) {
    result.restoredStopped = true;
  }
  if (started && management) {
    progress('restoring-stopped-state');
    try {
      await management.shutdown();
      for (let attempt = 0; attempt < 60 && !childHasExited(); attempt++) {
        await delay(250);
      }
      result.restoredStopped = childHasExited();
    } catch {
      result.restoreFailure = true;
      process.exitCode = 1;
    }
  }
  if (started && !childHasExited()) {
    child.kill();
    for (let attempt = 0; attempt < 60 && !childHasExited(); attempt++) {
      await delay(250);
    }
    result.forcedOwnedChildCleanup = true;
    result.restoredStopped = childHasExited();
    process.exitCode = 1;
  }
  if (result.sentry.readAvailable) {
    progress('checking-remote-sentry-receipt');
    for (let attempt = 0; attempt < 4; attempt++) {
      const issues = sentryRead('list-issues', [
        '--environment',
        'production',
        '--time-range',
        '24h',
        '--limit',
        '5',
        '--query',
        `release:"${release}"`,
      ]);
      const list = z
        .array(z.object({ id: z.string(), permalink: z.string().optional() }))
        .safeParse(issues.data);
      if (issues.ok && list.success && list.data.length) {
        const events = sentryRead('issue-events', [list.data[0].id, '--limit', '20']);
        const parsed = z
          .array(
            z.object({
              eventID: z.string(),
              dateCreated: z.string().optional(),
              tags: z.array(z.object({ key: z.string(), value: z.string() })).optional(),
            }),
          )
          .safeParse(events.data);
        const event = parsed.success
          ? parsed.data.find((item) =>
              item.tags?.some((tag) => tag.key === 'release' && tag.value === release),
            )
          : undefined;
        if (event) {
          const detail = sentryRead('event-detail', [event.eventID]);
          if (detail.ok) {
            result.sentry = {
              readAvailable: true,
              received: true,
              eventId: event.eventID,
              issueUrl: list.data[0].permalink,
              receivedAt: event.dateCreated,
            };
            break;
          }
        }
      }
      await delay(2500);
    }
  }
  if (sentryRelay) {
    await sentryRelay.close();
    result.sentryOutboundObservations = sentryRelay.observations;
  }
  if (!experimentalUserAgentVersion && !experimentalProductionEndpoint && !result.sentry.received) {
    result.sentry.receiptUnverified = true;
    process.exitCode = 1;
  }
  try {
    result.localDiagnostics = readLiveLocalDiagnostics(
      path.join(os.homedir(), '.antigravity-agent'),
      sessionStartedAt,
    );
  } catch {
    result.localDiagnosticEvidenceAvailable = false;
  }
  try {
    const database = new DatabaseSync(
      path.join(os.homedir(), '.antigravity-agent/proxy-state/request-audit.db'),
      { readOnly: true },
    );
    try {
      result.upstreamModels = readLiveUpstreamEvidence(database, tracePrefix);
    } finally {
      database.close();
    }
  } catch {
    result.auditModelEvidenceAvailable = false;
  }
  if (result.toolHistory?.signatureRecovery) {
    result.toolHistory.signatureRecovery.upstreamRetryVerified =
      result.auditModelEvidenceAvailable !== false &&
      hasVerifiedSignatureRecovery(result.upstreamModels ?? []);
    if (!result.toolHistory.signatureRecovery.upstreamRetryVerified) {
      process.exitCode = 1;
    }
  }
  progress('finished');
  const evidence = await format(JSON.stringify(result), { parser: 'json' });
  fs.writeFileSync(path.resolve('artifacts/schema-work-package/live-result.json'), evidence, {
    mode: 0o600,
  });
  const recordDirectory = path.resolve('artifacts/schema-work-package/live-results');
  fs.mkdirSync(recordDirectory, { recursive: true });
  fs.writeFileSync(path.join(recordDirectory, `${release}.json`), evidence, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
