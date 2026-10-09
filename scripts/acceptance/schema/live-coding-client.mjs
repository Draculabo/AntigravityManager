import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { z } from 'zod';
import { createLiveClientRelay } from './live-client-relay.mjs';

export async function runLiveCodingClient({
  workspace,
  marker,
  baseUrl,
  config,
  progress,
  result,
  tracePrefix,
  mcpConfig,
  measureSchemas,
}) {
  progress('request:claude-code-live-read');
  const clientDirectory = path.join(workspace, 'coding-client');
  fs.mkdirSync(clientDirectory);
  const clientProbe = path.join(clientDirectory, 'probe.txt');
  fs.writeFileSync(clientProbe, marker, { mode: 0o600 });
  const relay = await createLiveClientRelay({
    gateway: baseUrl,
    trace: tracePrefix,
    probe: clientProbe,
    marker,
    measureSchemas,
  });
  const environment = {};
  for (const name of [
    'PATH',
    'SystemRoot',
    'WINDIR',
    'TEMP',
    'TMP',
    'USERPROFILE',
    'HOME',
    'APPDATA',
    'LOCALAPPDATA',
  ]) {
    if (process.env[name]) {
      environment[name] = process.env[name];
    }
  }
  Object.assign(environment, {
    ANTHROPIC_BASE_URL: relay.baseUrl,
    ANTHROPIC_API_KEY: config.proxy.api_key || 'controlled-local-probe',
    CLAUDE_CONFIG_DIR: path.join(clientDirectory, 'config'),
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    ...(mcpConfig ? { ENABLE_TOOL_SEARCH: 'false' } : {}),
  });
  const executable = path.join(os.homedir(), '.local/bin/claude.exe');
  const invocation = spawn(
    executable,
    [
      ...(mcpConfig
        ? ['--setting-sources', '', '--settings', '{"disableAllHooks":true}']
        : ['--bare']),
      '--print',
      '--no-session-persistence',
      '--no-chrome',
      '--disable-slash-commands',
      '--strict-mcp-config',
      ...(mcpConfig ? ['--mcp-config', mcpConfig] : []),
      '--tools',
      mcpConfig ? 'default' : 'Read',
      '--allowedTools',
      mcpConfig ? 'Read,WaitForMcpServers' : 'Read',
      '--permission-mode',
      'dontAsk',
      '--permission-prompts',
      'none',
      '--max-turns',
      '4',
      '--model',
      'gemini-3.1-pro-high',
      '--output-format',
      'stream-json',
      '--verbose',
      '--system-prompt',
      'Run the controlled acceptance test. Use only Read (and WaitForMcpServers if needed). Read the provided file and output only its exact content. Do not invoke any MCP tools.',
      `Read ${clientProbe} and report its exact content.`,
    ],
    {
      cwd: clientDirectory,
      env: environment,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let text = '';
  invocation.stdout.on('data', (chunk) => {
    if (text.length < 1_048_576) {
      text += chunk.toString('utf8');
    }
  });
  invocation.stderr.on('data', () => undefined);
  const timeout = setTimeout(() => invocation.kill(), 120_000);
  const exit = await new Promise((resolve, reject) => {
    invocation.once('error', reject);
    invocation.once('close', resolve);
  }).finally(async () => {
    clearTimeout(timeout);
    await relay.close();
  });
  let matched = false;
  let diagnostic;
  try {
    const events = text
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line));
    const parsed = z
      .object({
        result: z.string().optional(),
        is_error: z.boolean().optional(),
        num_turns: z.number().optional(),
        permission_denials: z.array(z.unknown()).optional(),
      })
      .parse(events.findLast((event) => event.type === 'result'));
    matched = parsed.result?.includes(marker) === true;
    const assistants = events.filter((event) => event.type === 'assistant');
    const clientTextPresent = assistants.some((event) =>
      JSON.stringify(event.message?.content ?? '').includes(marker),
    );
    diagnostic = {
      isError: parsed.is_error,
      turns: parsed.num_turns,
      deniedPermissions: parsed.permission_denials?.length,
      resultPresent: typeof parsed.result === 'string',
      resultBytes: Buffer.byteLength(parsed.result ?? ''),
      clientTextPresent,
      assistantBlockTypes: assistants.map((event) =>
        Array.isArray(event.message?.content)
          ? event.message.content.map((block) => block.type)
          : [],
      ),
      markerPrefixPresent: parsed.result?.includes('gateway-read-') === true,
      mentionsPermission: /permission|allowed|denied/i.test(parsed.result ?? ''),
      mentionsAccess: /access|cannot|unable/i.test(parsed.result ?? ''),
      versionNotice: /version|antigravity/i.test(parsed.result ?? ''),
    };
  } catch {
    /* Only a validated final client result is acceptance. */
  }
  result.codingClient = {
    client: 'Claude Code',
    model: 'gemini-3.1-pro-high',
    exit,
    toolResultMatched: matched,
    diagnostic,
    gatewayObservations: relay.observations,
    configuredMcp: Boolean(mcpConfig),
  };
  if (exit !== 0 || !matched) {
    throw new Error('Live coding client did not complete the Read result');
  }
  if (mcpConfig) {
    assertConfiguredMcpEvidence(relay.observations);
  }
}

export function assertConfiguredMcpEvidence(observations) {
  if (
    !observations.some(
      (observation) =>
        observation.status === 200 &&
        observation.schemas?.mcpServerSchemas.codegraph > 0 &&
        observation.schemas?.mcpServerSchemas.memory > 0 &&
        observation.schemas?.mcpServerSchemas.sequentialThinking > 0 &&
        !observation.schemas.degraded,
    )
  ) {
    throw new Error('Live client did not send the configured MCP declarations without degradation');
  }
}
