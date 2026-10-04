import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';

import { createClient } from './clients.mjs';
import { collectAuditWindow } from './audit-window.mjs';
import {
  evaluateRun,
  summarizeEvents,
  summarizeRequests,
  summarizeStderr,
  taskId,
} from './summarize.mjs';

const thoughtStatsSchema = z.object({
  writeFailures: z.number().int().nonnegative(),
  workerAlive: z.boolean(),
});
const thoughtSessionsSchema = z.array(z.object({ recordCount: z.number().int().nonnegative() }));

function usage() {
  return [
    'Usage: node scripts/acceptance/agents/live-agent-acceptance.mjs --client claude|codex|opencode',
    '  --owner cli|electron --gateway http://127.0.0.1:PORT',
    '  [--profile-home PATH] [--output PATH] [--bin PATH] [--model MODEL]',
    '  [--client-settings PATH] (Claude/Codex: use an existing configuration without overrides)',
    '  [--opencode-major 1|2] [--codex-approval auto|never]',
    '  [--codex-shell-profile default|disabled] (explicit shell-startup diagnostic)',
    '  [--claude-system-prompt default|compact] [--claude-max-output-tokens N]',
    '  [--timeout-ms N]',
    '  [--max-input-tokens N] [--max-output-tokens N]',
    'Set AGM_ACCEPTANCE_API_KEY or provide --profile-home to read the existing local key.',
  ].join('\n');
}

function parseOptions(argv) {
  if (argv.includes('--help')) {
    console.log(usage());
    process.exit(0);
  }
  const allowed = new Set([
    'client',
    'owner',
    'gateway',
    'profile-home',
    'output',
    'bin',
    'model',
    'client-settings',
    'opencode-major',
    'codex-approval',
    'codex-shell-profile',
    'claude-system-prompt',
    'claude-max-output-tokens',
    'timeout-ms',
    'max-input-tokens',
    'max-output-tokens',
  ]);
  const values = {};
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    if (!flag?.startsWith('--') || !allowed.has(flag.slice(2)) || !argv[i + 1]) {
      throw new Error(`Invalid option: ${flag ?? '(missing)'}`);
    }
    values[flag.slice(2)] = argv[i + 1];
  }
  if (!['claude', 'codex', 'opencode'].includes(values.client)) {
    throw new Error('--client must be claude, codex, or opencode');
  }
  if (!['cli', 'electron'].includes(values.owner)) {
    throw new Error('--owner must be cli or electron');
  }
  if (values['client-settings'] && values.client === 'opencode') {
    throw new Error('--client-settings currently supports Claude Code and Codex only');
  }
  let gateway;
  try {
    gateway = new URL(values.gateway);
  } catch {
    throw new Error('--gateway must be a loopback HTTP URL');
  }
  if (
    gateway.protocol !== 'http:' ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(gateway.hostname) ||
    gateway.pathname !== '/' ||
    gateway.search ||
    gateway.hash ||
    gateway.username ||
    gateway.password
  ) {
    throw new Error('--gateway must be a loopback HTTP origin');
  }
  const numeric = (name, fallback, min, max) => {
    const value = values[name] === undefined ? fallback : Number(values[name]);
    if (value !== null && (!Number.isInteger(value) || value < min || value > max)) {
      throw new Error(`Invalid --${name}`);
    }
    return value;
  };
  const model = values.model ?? 'claude-sonnet-4-6-thinking';
  if (!/^[a-zA-Z0-9._-]{1,100}$/.test(model)) {
    throw new Error('Invalid --model');
  }
  if (values['codex-approval'] && !['auto', 'never'].includes(values['codex-approval'])) {
    throw new Error('--codex-approval must be auto or never');
  }
  if (
    values['codex-shell-profile'] &&
    !['default', 'disabled'].includes(values['codex-shell-profile'])
  ) {
    throw new Error('--codex-shell-profile must be default or disabled');
  }
  if (
    values['claude-system-prompt'] &&
    !['default', 'compact'].includes(values['claude-system-prompt'])
  ) {
    throw new Error('--claude-system-prompt must be default or compact');
  }
  return {
    client: values.client,
    owner: values.owner,
    gateway: gateway.origin,
    profileHome: path.resolve(values['profile-home'] ?? os.homedir()),
    output: path.resolve(values.output ?? 'out/live-agent-acceptance'),
    bin: values.bin,
    model,
    clientSettings: values['client-settings'] ? path.resolve(values['client-settings']) : null,
    opencodeMajor: numeric('opencode-major', 2, 1, 2),
    codexApproval: values['codex-approval'] ?? 'auto',
    codexShellProfile: values['codex-shell-profile'] ?? 'default',
    claudeSystemPrompt: values['claude-system-prompt'] ?? 'default',
    claudeMaxOutputTokens: numeric('claude-max-output-tokens', null, 1, 32000),
    timeoutMs: numeric('timeout-ms', 300000, 30000, 600000),
    budgets: {
      input: numeric('max-input-tokens', null, 1, 1_000_000),
      output: numeric('max-output-tokens', null, 1, 1_000_000),
    },
  };
}

async function getApiKey(profileHome) {
  if (process.env.AGM_ACCEPTANCE_API_KEY) {
    return process.env.AGM_ACCEPTANCE_API_KEY;
  }
  const file = path.join(profileHome, '.antigravity-agent', 'gui_config.json');
  const config = z
    .object({ proxy: z.object({ api_key: z.string().min(1) }) })
    .parse(JSON.parse(await fs.readFile(file, 'utf8')));
  return config.proxy.api_key;
}

async function runProcess(bin, args, env, cwd, timeoutMs, maxBytes = 2_000_000) {
  const child = spawn(bin, args, {
    cwd,
    env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  let timedOut = false;
  child.stdout.on('data', (chunk) => {
    stdout = (stdout + chunk).slice(-maxBytes);
  });
  child.stderr.on('data', (chunk) => {
    stderr = (stderr + chunk).slice(-100_000);
  });
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, timeoutMs);
  const exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  }).finally(() => clearTimeout(timer));
  return { exitCode, timedOut, stdout, stderr, stderrBytes: stderr.length };
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  const apiKey = await getApiKey(options.profileHome);
  const headers = { authorization: `Bearer ${apiKey}` };
  const getJson = async (route, schema) => {
    const response = await fetch(`${options.gateway}${route}`, {
      headers,
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      throw new Error(
        `Gateway diagnostic request failed: ${response.status} ${route.split('?')[0]}`,
      );
    }
    const body = await response.json();
    return schema.parse(body);
  };
  await getJson('/v1/models', z.object({ data: z.array(z.unknown()) }));
  const thoughtBefore = await getJson('/internal/thinking/stats', thoughtStatsSchema);
  const sessionsBefore = await getJson(
    '/internal/thinking/sessions?limit=200',
    thoughtSessionsSchema,
  );
  const recordCount = (sessions) => sessions.reduce((sum, session) => sum + session.recordCount, 0);
  await fs.mkdir(options.output, { recursive: true, mode: 0o700 });
  const runDir = await fs.mkdtemp(path.join(options.output, `${options.client}-${options.owner}-`));
  const home = path.join(runDir, 'home');
  const workspace = path.join(runDir, 'workspace');
  await Promise.all([
    fs.mkdir(home, { recursive: true, mode: 0o700 }),
    fs.mkdir(workspace, { recursive: true, mode: 0o700 }),
  ]);
  const client = await createClient({ ...options, home, workspace, apiKey });
  const versionResult = await runProcess(
    client.bin,
    ['--version'],
    client.env,
    workspace,
    10000,
    2000,
  );
  const clientVersion =
    versionResult.exitCode === 0
      ? (versionResult.stdout.trim().split('\n')[0]?.slice(0, 120) ?? null)
      : null;
  const startedAt = Date.now();
  const processResult = await runProcess(
    client.bin,
    client.args,
    client.env,
    workspace,
    options.timeoutMs,
  );
  const endedAt = Date.now();
  await new Promise((resolve) => setTimeout(resolve, 1500));

  const { details } = await collectAuditWindow({
    getJson,
    startedAt,
    endedAt,
    model: options.model,
    protocol: client.protocol,
  });
  const audit = summarizeRequests(details);
  const events = summarizeEvents(options.client, processResult.stdout, workspace);
  const thoughtAfter = await getJson('/internal/thinking/stats', thoughtStatsSchema);
  const sessionsAfter = await getJson(
    '/internal/thinking/sessions?limit=200',
    thoughtSessionsSchema,
  );
  let artifactBytes = null;
  try {
    const stat = await fs.stat(path.join(workspace, 'todo.html'));
    if (stat.isFile()) {
      artifactBytes = stat.size;
    }
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
  }
  const thoughtWriteFailuresDelta = thoughtAfter.writeFailures - thoughtBefore.writeFailures;
  const verdict = evaluateRun({
    exitCode: processResult.exitCode,
    timedOut: processResult.timedOut,
    artifactBytes,
    events,
    audit,
    thoughtWriteFailuresDelta,
    budgets: options.budgets,
  });
  const report = {
    schemaVersion: 1,
    taskId,
    platform: process.platform,
    ownerDeclared: options.owner,
    client: options.client,
    codexApproval: options.client === 'codex' ? options.codexApproval : null,
    codexShellProfile: options.client === 'codex' ? options.codexShellProfile : null,
    claudeSystemPrompt: options.client === 'claude' ? options.claudeSystemPrompt : null,
    claudeMaxOutputTokens: options.client === 'claude' ? options.claudeMaxOutputTokens : null,
    clientVersion,
    configurationSource: options.clientSettings ? 'existing-client-settings' : 'sop-generated',
    opencodeMajor: options.client === 'opencode' ? options.opencodeMajor : null,
    model: options.model,
    gateway: options.gateway,
    startedAt,
    endedAt,
    durationMs: endedAt - startedAt,
    workspace,
    artifactBytes,
    exitCode: processResult.exitCode,
    timedOut: processResult.timedOut,
    stdoutBytes: processResult.stdout.length,
    stderrBytes: processResult.stderrBytes,
    stderrSignals: summarizeStderr(processResult.stderr),
    events,
    audit,
    thought: {
      workerAliveBefore: thoughtBefore.workerAlive,
      workerAliveAfter: thoughtAfter.workerAlive,
      writeFailuresDelta: thoughtWriteFailuresDelta,
      recordCountDelta: recordCount(sessionsAfter) - recordCount(sessionsBefore),
      reasoningTokensAvailable: audit.reasoningTokens !== null,
    },
    budgets: options.budgets,
    verdict,
  };
  const reportPath = path.join(runDir, 'report.json');
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(
    JSON.stringify({
      reportPath,
      passed: verdict.passed,
      failures: verdict.failures,
      requests: audit.count,
      inputTokens: audit.inputTokens,
      outputTokens: audit.outputTokens,
      upstream429Attempts: audit.upstream429Attempts,
      artifactBytes,
    }),
  );
  if (!verdict.passed) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'Live acceptance failed');
  process.exitCode = 1;
});
