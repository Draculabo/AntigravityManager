import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { spawn, spawnSync } from 'node:child_process';
import { clientFinalMatches } from './multi-client-protocol.mjs';
import { z } from 'zod';

function executable(client) {
  const installation = path.dirname(process.execPath);
  if (client === 'claude') {
    return path.join(os.homedir(), '.local/bin/claude.exe');
  }
  if (client === 'opencode') {
    return path.join(installation, 'node_modules/opencode-ai/bin/opencode.exe');
  }
  const codex = path.join(installation, 'node_modules/@openai/codex');
  const require = createRequire(path.join(codex, 'package.json'));
  let vendor;
  try {
    vendor = path.join(
      path.dirname(require.resolve('@openai/codex-win32-x64/package.json')),
      'vendor',
    );
  } catch {
    vendor = path.join(codex, 'vendor');
  }
  return path.join(vendor, 'x86_64-pc-windows-msvc/bin/codex.exe');
}

function environment() {
  const env = {};
  for (const name of [
    'PATH',
    'SystemRoot',
    'WINDIR',
    'TEMP',
    'TMP',
    'USERPROFILE',
    'APPDATA',
    'LOCALAPPDATA',
  ]) {
    if (process.env[name]) {
      env[name] = process.env[name];
    }
  }
  return env;
}

export async function invokeReadOnlyClient({ client, directory, baseUrl, marker, mcpConfig }) {
  const program = executable(client);
  if (!fs.existsSync(program)) {
    throw new Error('Inspected client executable is unavailable');
  }
  const env = environment();
  const version = spawnSync(program, ['--version'], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 10_000,
    maxBuffer: 16_384,
    env,
  });
  const clientVersion = `${version.stdout ?? ''}${version.stderr ?? ''}`.match(
    /\d+\.\d+\.\d+/,
  )?.[0];
  const key = 'controlled-loopback-client';
  let args;
  if (client === 'codex') {
    env.CODEX_HOME = path.join(directory, 'codex-home');
    env.AGM_CLIENT_PROXY_KEY = key;
    fs.mkdirSync(env.CODEX_HOME);
    args = [
      'exec',
      '--ephemeral',
      '--skip-git-repo-check',
      '--sandbox',
      'read-only',
      '--json',
      '--color',
      'never',
      '-c',
      'approval_policy="never"',
      '-c',
      'project_doc_max_bytes=0',
      '-c',
      'features.apps=false',
      '-c',
      'features.multi_agent=false',
      '-c',
      'features.shell_snapshot=false',
      '-c',
      `mcp_servers.probe={command=${JSON.stringify(process.execPath)},args=${JSON.stringify([path.resolve('scripts/acceptance/schema/client-probe-mcp.mjs'), path.join(directory, 'probe.txt')])}}`,
      '-c',
      'web_search="disabled"',
      '-c',
      'model_provider="agm_test"',
      '-c',
      `model_providers.agm_test={name="Controlled Gateway",base_url="${baseUrl}/v1",env_key="AGM_CLIENT_PROXY_KEY",wire_api="responses",supports_websockets=false,request_max_retries=0,stream_max_retries=0}`,
      '-m',
      'gemini-3.7-flash-high',
      '-C',
      directory,
      'Use the MCP probe read_probe tool once to read the controlled probe file. Do not use shell or other tools, modify nothing, and output only the exact returned file content.',
    ];
  } else if (client === 'opencode') {
    for (const name of ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME']) {
      env[name] = path.join(directory, name.toLowerCase());
      fs.mkdirSync(env[name]);
    }
    env.OPENCODE_DISABLE_MODELS_FETCH = 'true';
    env.OPENCODE_DISABLE_PROJECT_CONFIG = 'true';
    env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
      enabled_providers: ['agm_test'],
      model: 'agm_test/gemini-3.7-flash-high',
      provider: {
        agm_test: {
          npm: '@ai-sdk/openai-compatible',
          name: 'Controlled Gateway',
          options: { baseURL: `${baseUrl}/v1`, apiKey: key },
          models: {
            'gemini-3.7-flash-high': {
              name: 'Controlled Flash',
              limit: { context: 262144, output: 8192 },
            },
          },
        },
      },
      permission: {
        '*': 'deny',
        // The relay enforces the canonical fixed-file boundary before any read reaches the client.
        read: 'allow',
        glob: 'allow',
        grep: 'allow',
        external_directory: 'deny',
      },
      agent: {
        probe: {
          mode: 'primary',
          steps: 4,
          prompt:
            'Only inspect probe.txt in this test directory with read/search tools. Modify nothing. Output only its exact content.',
        },
      },
    });
    args = [
      'run',
      '--pure',
      '--agent',
      'probe',
      '--model',
      'agm_test/gemini-3.7-flash-high',
      '--format',
      'json',
      '--dir',
      directory,
      'Find probe.txt using glob, read it using the read tool, and output only its exact content. Do not read any other files.',
    ];
  } else {
    env.ANTHROPIC_BASE_URL = baseUrl;
    env.ANTHROPIC_API_KEY = key;
    env.CLAUDE_CONFIG_DIR = path.join(directory, 'claude-config');
    env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
    env.ENABLE_TOOL_SEARCH = 'false';
    args = [
      '--setting-sources',
      '',
      '--settings',
      '{"disableAllHooks":true}',
      '--print',
      '--no-session-persistence',
      '--no-chrome',
      '--disable-slash-commands',
      '--strict-mcp-config',
      '--mcp-config',
      mcpConfig,
      '--tools',
      'default',
      '--allowedTools',
      'Read,Glob,Grep,WaitForMcpServers',
      '--permission-mode',
      'dontAsk',
      '--permission-prompts',
      'none',
      '--max-turns',
      '5',
      '--model',
      'gemini-3.7-flash-high',
      '--output-format',
      'stream-json',
      '--verbose',
      '--system-prompt',
      'Run the controlled read-only acceptance test. Only Glob, Grep, Read and the MCP startup wait are allowed. Do not invoke MCP business tools or modify files. Output only the exact probe content.',
      'Use Glob to find probe.txt in the current directory, then Grep to inspect its content, then Read to read it. Read no other file and output only the exact content.',
    ];
  }
  const child = spawn(program, args, {
    cwd: directory,
    env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  let overflow = false;
  let timedOut = false;
  let spawnFailed = false;
  child.stdout.on('data', (chunk) => {
    if (Buffer.byteLength(stdout) + chunk.length > 2_097_152) {
      overflow = true;
      child.kill();
    } else {
      stdout += chunk.toString('utf8');
    }
  });
  child.stderr.on('data', (chunk) => {
    if (stderr.length < 16_384) {
      stderr += chunk.toString('utf8').slice(0, 16_384 - stderr.length);
    }
  });
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, 180_000);
  const exit = await new Promise((resolve) => {
    child.once('error', () => {
      spawnFailed = true;
      resolve(null);
    });
    child.once('close', resolve);
  }).finally(() => clearTimeout(timeout));
  const stdoutSummary = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (stdoutSummary.length >= 64) {
      break;
    }
    let raw;
    try {
      raw = JSON.parse(line);
    } catch {
      continue;
    }
    const event = z
      .object({
        type: z.string(),
        item: z.object({ type: z.string(), text: z.string().optional() }).optional(),
      })
      .safeParse(raw);
    if (event.success) {
      stdoutSummary.push({
        event: [
          'thread.started',
          'turn.started',
          'turn.completed',
          'turn.failed',
          'item.started',
          'item.updated',
          'item.completed',
          'error',
          'result',
          'text',
          'tool_use',
          'assistant',
          'system',
          'user',
          'step_start',
          'step_finish',
        ].includes(event.data.type)
          ? event.data.type
          : 'other',
        itemType: [
          'agent_message',
          'reasoning',
          'command_execution',
          'mcp_tool_call',
          'file_change',
          'web_search',
          'todo_list',
          'message',
          'assistant_message',
          'function_call',
          'function_call_output',
        ].includes(event.data.item?.type)
          ? event.data.item.type
          : 'other',
        itemTextBytes: Buffer.byteLength(event.data.item?.text ?? ''),
        markerPresent: JSON.stringify(raw).includes(marker),
      });
    }
  }
  return {
    clientVersion,
    exit,
    timedOut,
    overflow,
    spawnFailed,
    finalMatched: clientFinalMatches(client, stdout, marker),
    stdoutSummary,
    failureSignals: {
      permission: /permission|sandbox|denied/i.test(stderr),
      configuration: /invalid config|unknown field|configuration error/i.test(stderr),
      provider: /provider.*error|api.*error|stream.*error/i.test(stderr),
    },
  };
}
