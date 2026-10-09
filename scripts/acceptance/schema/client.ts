import { createServer, type ServerResponse } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { format } from 'prettier';
import { prepareClientMcpConfig } from './client-mcp-config';
import { measureClientSchemas } from './client-schema-metrics';

const Request = z.object({
  model: z.string(),
  stream: z.boolean().optional(),
  tools: z.array(z.object({ name: z.string(), input_schema: z.unknown() })).optional(),
  messages: z.array(z.object({ content: z.unknown() })),
});
const PROBE = 'schema-client-read-probe-2026-10-08';
async function runClient(): Promise<void> {
  const toolSet = z
    .enum(['Read', 'default', 'configured-mcp', 'configured-full'])
    .parse(process.argv[3] ?? 'Read');
  const configured = toolSet.startsWith('configured-');
  const workspace = path.resolve('out/schema-work-package');
  await mkdir(workspace, { recursive: true });
  const directory = await mkdtemp(path.join(workspace, 'client-'));
  const probePath = path.join(directory, 'probe.txt');
  await writeFile(probePath, PROBE, { mode: 0o600 });
  const summary = {
    client: 'Claude Code',
    toolSet,
    requests: 0,
    schemas: 0,
    mcpSchemas: 0,
    mcpServerSchemas: { codegraph: 0, memory: 0, sequentialThinking: 0 },
    maxToolsPerRequest: 0,
    degraded: 0,
    maxNodes: 0,
    maxBytes: 0,
    schemaDigests: [] as string[],
    toolResultMatched: false,
    clientExit: null as number | null,
    waitForMcpInvoked: false,
  };
  let toolSent = false;
  let failed = false;

  function answer(
    response: ServerResponse,
    model: string,
    stream: boolean,
    tool: boolean,
    waitForMcp = false,
  ): void {
    const toolName = waitForMcp ? 'WaitForMcpServers' : 'Read';
    const toolId = waitForMcp ? 'schema_wait_call' : 'schema_read_call';
    const toolInput = waitForMcp ? {} : { file_path: probePath };
    const block = tool
      ? { type: 'tool_use', id: toolId, name: toolName, input: toolInput }
      : { type: 'text', text: 'Controlled Schema acceptance complete.' };
    const message = {
      id: 'msg_schema_probe',
      type: 'message',
      role: 'assistant',
      model,
      content: [block],
      stop_reason: tool ? 'tool_use' : 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 10 },
    };
    if (!stream) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(message));
      return;
    }
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const event = (type: string, value: object) =>
      response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`);
    event('message_start', {
      message: {
        ...message,
        content: [],
        stop_reason: null,
        usage: { input_tokens: 10, output_tokens: 0 },
      },
    });
    event('content_block_start', {
      index: 0,
      content_block: tool
        ? { type: 'tool_use', id: toolId, name: toolName, input: {} }
        : { type: 'text', text: '' },
    });
    event('content_block_delta', {
      index: 0,
      delta: tool
        ? { type: 'input_json_delta', partial_json: JSON.stringify(toolInput) }
        : { type: 'text_delta', text: 'Controlled Schema acceptance complete.' },
    });
    event('content_block_stop', { index: 0 });
    event('message_delta', {
      delta: { stop_reason: message.stop_reason, stop_sequence: null },
      usage: { output_tokens: 10 },
    });
    event('message_stop', {});
    response.end();
  }

  const server = createServer((request, response) => {
    if (request.method !== 'POST' || !request.url?.startsWith('/v1/messages')) {
      response.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    let bytes = 0;
    request.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 1_048_576) {
        request.destroy();
        failed = true;
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      try {
        const raw: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const value = Request.parse(raw);
        const measured = measureClientSchemas(value.tools ?? []);
        summary.maxToolsPerRequest = Math.max(summary.maxToolsPerRequest, value.tools?.length ?? 0);
        for (const digest of measured.schemaDigests) {
          if (!summary.schemaDigests.includes(digest)) {
            summary.schemaDigests.push(digest);
          }
        }
        summary.schemas += measured.schemas;
        summary.mcpSchemas += measured.mcpSchemas;
        summary.mcpServerSchemas.codegraph += measured.mcpServerSchemas.codegraph;
        summary.mcpServerSchemas.memory += measured.mcpServerSchemas.memory;
        summary.mcpServerSchemas.sequentialThinking += measured.mcpServerSchemas.sequentialThinking;
        summary.requests++;
        summary.degraded += measured.degraded ? 1 : 0;
        summary.maxNodes = Math.max(summary.maxNodes, measured.nodes);
        summary.maxBytes = Math.max(summary.maxBytes, measured.bytes);
        if (JSON.stringify(value.messages).includes(PROBE)) {
          summary.toolResultMatched = true;
        }
        const waitForMcp =
          configured &&
          summary.mcpSchemas === 0 &&
          !summary.waitForMcpInvoked &&
          Boolean(value.tools?.some((tool) => tool.name === 'WaitForMcpServers'));
        summary.waitForMcpInvoked ||= waitForMcp;
        const invokeTool =
          !waitForMcp && !toolSent && Boolean(value.tools?.some((tool) => tool.name === 'Read'));
        toolSent ||= invokeTool;
        answer(response, value.model, value.stream === true, invokeTool || waitForMcp, waitForMcp);
      } catch {
        failed = true;
        response.writeHead(400, { 'content-type': 'application/json' }).end(
          JSON.stringify({
            type: 'error',
            error: {
              type: 'invalid_request_error',
              message: 'Controlled Schema validation failed',
            },
          }),
        );
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Local probe could not listen');
  }
  const environment: NodeJS.ProcessEnv = {};
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
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`,
    ANTHROPIC_API_KEY: 'controlled-local-probe',
    CLAUDE_CONFIG_DIR: path.join(directory, 'client-config'),
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    ...(configured ? { ENABLE_TOOL_SEARCH: 'false' } : {}),
  });
  try {
    const executable = process.argv[2];
    if (!executable) {
      throw new Error('Client executable is required');
    }
    const mcpConfig = configured ? await prepareClientMcpConfig(directory) : undefined;
    const child = spawn(
      executable,
      [
        ...(toolSet === 'configured-full'
          ? ['--setting-sources', '', '--settings', '{"disableAllHooks":true}']
          : ['--bare']),
        '--print',
        '--no-session-persistence',
        '--no-chrome',
        '--disable-slash-commands',
        '--strict-mcp-config',
        ...(mcpConfig ? ['--mcp-config', mcpConfig] : []),
        '--tools',
        configured ? 'default' : toolSet,
        '--allowedTools',
        configured ? 'Read,WaitForMcpServers' : 'Read',
        '--permission-mode',
        'dontAsk',
        '--permission-prompts',
        'none',
        '--model',
        'claude-sonnet-4-6',
        '--system-prompt',
        'Run the controlled acceptance test using only Read.',
        `Read ${probePath} and finish.`,
      ],
      { cwd: directory, env: environment, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    // Never publish CLI context, model text or raw requests. Drain output without retaining it.
    child.stdout.on('data', () => undefined);
    child.stderr.on('data', () => undefined);
    const timer = setTimeout(() => child.kill(), configured ? 120_000 : 45_000);
    summary.clientExit = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    }).finally(() => clearTimeout(timer));
  } catch {
    failed = true;
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  await mkdir(path.resolve('artifacts/schema-work-package'), { recursive: true });
  await writeFile(
    path.resolve(`artifacts/schema-work-package/client-${toolSet}.json`),
    await format(JSON.stringify(summary), { parser: 'json' }),
  );
  process.stdout.write(`${JSON.stringify(summary)}\n`);
  if (
    failed ||
    summary.clientExit !== 0 ||
    summary.schemas === 0 ||
    !summary.toolResultMatched ||
    (configured && summary.mcpSchemas === 0)
  ) {
    process.exitCode = 1;
  }
}
void runClient().catch(() => {
  process.stderr.write('Controlled client acceptance could not complete.\n');
  process.exitCode = 1;
});
