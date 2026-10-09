import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { readClientMatrixUpstream, clientUpstreamPasses } from './multi-client-upstream.mjs';
import os from 'node:os';
import path from 'node:path';
import { createMultiClientRelay } from './multi-client-relay.mjs';
import {
  clientSchemaMetrics,
  requestToolResultMatches,
  responseToolCalls,
  toolCallsAreReadOnly,
  clientEvidencePasses,
  clientFinalMatches,
} from './multi-client-protocol.mjs';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agm-client-matrix-fixture-'));
fs.writeFileSync(path.join(directory, 'probe.txt'), 'public fixture');
after(() => {
  const resolved = path.resolve(directory);
  assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
  assert(path.basename(resolved).startsWith('agm-client-matrix-fixture-'));
  fs.rmSync(resolved, { recursive: true });
});
const marker = 'private-fixture-marker';
const schema = { type: 'object', properties: { file_path: { type: 'string' } } };
const measureSchemas = (tools) => ({
  schemas: tools.length,
  degraded: false,
  nodes: 3,
  bytes: 20,
  schemaDigests: [],
  mcpSchemas: 0,
  mcpServerSchemas: { codegraph: 0, memory: 0, sequentialThinking: 0 },
});
const event = (value) => `data: ${JSON.stringify(value)}\n\n`;

test('client declarations preserve actual protocol schemas and custom-tool exclusion', () => {
  const calls = [];
  const measure = (tools) => {
    calls.push(tools);
    return measureSchemas(tools);
  };
  clientSchemaMetrics({ tools: [{ name: 'Read', input_schema: schema }] }, measure);
  clientSchemaMetrics(
    { tools: [{ type: 'function', function: { name: 'read', parameters: schema } }] },
    measure,
  );
  const nested = clientSchemaMetrics(
    {
      tools: [
        {
          type: 'namespace',
          name: 'functions',
          tools: [
            { type: 'function', name: 'shell_command', parameters: schema },
            { type: 'custom', name: 'apply_patch', format: { type: 'grammar' } },
          ],
        },
      ],
    },
    measure,
  );
  assert.deepEqual(calls, [
    [{ name: 'Read', input_schema: schema }],
    [{ name: 'read', input_schema: schema }],
    [{ name: 'shell_command', input_schema: schema }],
  ]);
  assert.equal(nested.nonSchemaTools, 1);
});

test('tool-result evidence cannot be substituted by a prompt or unrelated tool output', () => {
  assert.equal(
    requestToolResultMatches({ input: [{ role: 'user', content: marker }] }, marker),
    false,
  );
  assert.equal(
    requestToolResultMatches({ input: [{ type: 'function_call_output', output: marker }] }, marker),
    true,
  );
  assert.equal(
    requestToolResultMatches({ messages: [{ role: 'tool', content: marker }] }, marker),
    true,
  );
  assert.equal(
    requestToolResultMatches(
      { messages: [{ role: 'user', content: [{ type: 'tool_result', content: marker }] }] },
      marker,
    ),
    true,
  );
  assert.equal(
    requestToolResultMatches({ messages: [{ role: 'tool', content: 'wrong-result' }] }, marker),
    false,
  );
});

test('stream guards reconstruct calls and reject writes, arbitrary shell and external paths', () => {
  assert.equal(
    toolCallsAreReadOnly([{ name: 'mcp__probe__read_probe', arguments: '{}' }], directory),
    true,
  );
  assert.deepEqual(
    responseToolCalls(
      event({
        type: 'response.output_item.done',
        item: {
          id: 'namespace-probe',
          type: 'function_call',
          name: 'read_probe',
          namespace: 'mcp__probe',
          arguments: '{}',
        },
      }),
    ),
    [{ name: 'mcp__probe__read_probe', arguments: '{}' }],
  );
  assert.equal(
    toolCallsAreReadOnly(
      [{ name: 'mcp__probe__read_probe', arguments: '{"path":"private.txt"}' }],
      directory,
    ),
    false,
  );
  const frames =
    event({ type: 'response.output_text.delta', delta: 'controlled ordinary text' }) +
    event({
      type: 'response.output_item.added',
      item: { id: 'fc', type: 'function_call', name: 'shell_command', arguments: '' },
    }) +
    event({
      type: 'response.output_item.done',
      item: {
        id: 'fc',
        type: 'function_call',
        name: 'shell_command',
        arguments: '{"command":"Get-Content -LiteralPath ./probe.txt","login":false}',
      },
    });
  assert.equal(toolCallsAreReadOnly(responseToolCalls(frames), directory), true);
  for (const extra of [
    { workdir: path.dirname(directory) },
    { login: true },
    { shell: 'cmd.exe' },
  ]) {
    assert.equal(
      toolCallsAreReadOnly(
        [
          {
            name: 'exec_command',
            arguments: JSON.stringify({
              cmd: 'Get-Content -LiteralPath ./probe.txt',
              login: false,
              ...extra,
            }),
          },
        ],
        directory,
      ),
      false,
    );
  }
  assert.equal(
    toolCallsAreReadOnly(
      [{ name: 'shell_command', arguments: '{"command":"Remove-Item probe.txt"}' }],
      directory,
    ),
    false,
  );
  assert.equal(
    toolCallsAreReadOnly(
      [
        {
          name: 'Read',
          arguments: JSON.stringify({ file_path: path.join(directory, '..', 'private.txt') }),
        },
      ],
      directory,
    ),
    false,
  );
  assert.equal(toolCallsAreReadOnly([{ name: 'write', arguments: '{}' }], directory), false);
  const anthropic =
    event({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', name: 'Read', input: {} },
    }) +
    event({
      type: 'content_block_delta',
      index: 0,
      delta: { partial_json: JSON.stringify({ file_path: path.join(directory, 'probe.txt') }) },
    });
  assert.equal(toolCallsAreReadOnly(responseToolCalls(anthropic), directory), true);
  assert.equal(
    toolCallsAreReadOnly(
      [
        {
          name: 'Read',
          arguments: JSON.stringify({
            file_path: fs.realpathSync.native(path.join(directory, 'probe.txt')),
          }),
        },
      ],
      directory,
    ),
    true,
  );
  const chat =
    event({
      choices: [
        {
          delta: {
            tool_calls: [{ index: 0, function: { name: 'read', arguments: '{"filePath":' } }],
          },
        },
      ],
    }) +
    event({
      choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"probe.txt"}' } }] } }],
    });
  assert.deepEqual(responseToolCalls(chat), [
    { name: 'read', arguments: '{"filePath":"probe.txt"}' },
  ]);
});

test('probe MCP exposes one fixed file and rejects arbitrary arguments', () => {
  const clientDirectory = path.join(directory, 'codex');
  fs.mkdirSync(clientDirectory);
  fs.writeFileSync(path.join(clientDirectory, 'probe.txt'), 'fixed MCP fixture');
  const requests = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'read_probe', arguments: {} } },
    {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'read_probe', arguments: { path: '../private.txt' } },
    },
  ];
  const run = spawnSync(
    process.execPath,
    [
      path.resolve('scripts/acceptance/schema/client-probe-mcp.mjs'),
      path.join(clientDirectory, 'probe.txt'),
    ],
    {
      input: requests.map((request) => JSON.stringify(request)).join('\n') + '\n',
      encoding: 'utf8',
      timeout: 10_000,
      maxBuffer: 65_536,
      windowsHide: true,
    },
  );
  assert.equal(run.status, 0);
  const replies = run.stdout
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line));
  assert.equal(replies[1].result.tools.length, 1);
  assert.deepEqual(replies[2].result, { content: [{ type: 'text', text: 'fixed MCP fixture' }] });
  assert.deepEqual(replies[3].result, {
    isError: true,
    content: [{ type: 'text', text: 'Only the fixed read-only probe tool is available.' }],
  });
});

test('client completion requires a final message, successful request and real result continuation', () => {
  assert.equal(
    clientFinalMatches(
      'codex',
      JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', text: marker } }),
      marker,
    ),
    false,
  );
  assert.equal(
    clientFinalMatches(
      'codex',
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: marker } }),
      marker,
    ),
    true,
  );
  const evidence = {
    exit: 0,
    finalMatched: true,
    observations: [
      {
        status: 200,
        safeTools: true,
        toolCalls: 1,
        toolResultMatched: false,
        schemas: { schemas: 1, degraded: false },
      },
      {
        status: 200,
        safeTools: true,
        toolCalls: 0,
        toolResultMatched: true,
        schemas: { schemas: 1, degraded: false },
      },
    ],
  };
  assert.equal(clientEvidencePasses(evidence), true);
  assert.equal(clientEvidencePasses({ ...evidence, finalMatched: false }), false);
  assert.equal(
    clientEvidencePasses({
      ...evidence,
      observations: evidence.observations.map((item) => ({ ...item, toolResultMatched: false })),
    }),
    false,
  );
  assert.equal(clientEvidencePasses({ ...evidence, exit: 1 }), false);
});

test('upstream proof keeps recovered failures and rejects incomplete or failed request groups', () => {
  const database = new DatabaseSync(':memory:');
  try {
    database.exec(
      'CREATE TABLE request_logs(id TEXT,request_headers TEXT,timestamp INTEGER); CREATE TABLE upstream_attempts(parent_id TEXT,model TEXT,status INTEGER,attempt_index INTEGER);',
    );
    const insertRequest = database.prepare('INSERT INTO request_logs VALUES(?,?,?)');
    const insertAttempt = database.prepare('INSERT INTO upstream_attempts VALUES(?,?,?,?)');
    insertRequest.run('private-a', '{"x-schema-acceptance":"controlled:multi-client:claude"}', 1);
    insertRequest.run('private-b', '{"x-schema-acceptance":"controlled:multi-client:claude"}', 2);
    insertAttempt.run('private-a', 'gemini-3.7-flash-high', 403, 1);
    insertAttempt.run('private-a', 'gemini-3.7-flash-high', 200, 2);
    insertAttempt.run('private-b', 'gemini-3.7-flash-high', 200, 1);
    const evidence = readClientMatrixUpstream(database, 'controlled');
    assert.deepEqual(evidence, [
      {
        client: 'claude',
        requestOrdinal: 1,
        attempts: [
          { model: 'gemini-3.7-flash-high', status: 403 },
          { model: 'gemini-3.7-flash-high', status: 200 },
        ],
      },
      {
        client: 'claude',
        requestOrdinal: 2,
        attempts: [{ model: 'gemini-3.7-flash-high', status: 200 }],
      },
    ]);
    assert.equal(clientUpstreamPasses(evidence, 2), true);
    assert.equal(clientUpstreamPasses(evidence, 3), false);
    assert.equal(clientUpstreamPasses([], 0), false);
    assert.doesNotMatch(
      JSON.stringify(evidence),
      /private-a|private-b|x-schema-acceptance|controlled/,
    );
    database.exec("UPDATE upstream_attempts SET status=403 WHERE parent_id='private-b'");
    assert.equal(clientUpstreamPasses(readClientMatrixUpstream(database, 'controlled'), 2), false);
    database.exec("UPDATE upstream_attempts SET model='wrong-model'");
    assert.equal(clientUpstreamPasses(readClientMatrixUpstream(database, 'controlled'), 2), false);
  } finally {
    database.close();
  }
});

test('relay preserves request bytes and replaces credentials privately while blocking unsafe calls', async () => {
  const forwarded = [];
  let unsafe = false;
  const relay = await createMultiClientRelay({
    gateway: 'http://127.0.0.1:1234',
    apiKey: 'private-gateway-key',
    client: 'codex',
    trace: 'controlled',
    directory,
    marker,
    measureSchemas,
    forward: async (url, init) => {
      forwarded.push({
        route: url.pathname,
        body: init.body.toString(),
        authorization: init.headers.get('authorization'),
      });
      return new Response(
        event({
          type: 'response.output_item.done',
          item: {
            id: 'fc',
            type: 'function_call',
            name: unsafe ? 'write' : 'shell_command',
            arguments: unsafe
              ? '{}'
              : '{"command":"Get-Content -LiteralPath ./probe.txt","login":false}',
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      );
    },
  });
  const body = JSON.stringify({
    tools: [{ type: 'function', name: 'shell_command', parameters: schema }],
    input: [{ role: 'user', content: 'Read the controlled file.' }],
  });
  try {
    const response = await fetch(`${relay.baseUrl}/v1/responses`, {
      method: 'POST',
      headers: { authorization: 'Bearer private-client-key', 'content-type': 'application/json' },
      body,
    });
    assert.equal(response.status, 200);
    assert.match(await response.text(), /shell_command/);
    assert.deepEqual(forwarded, [
      { route: '/v1/responses', body, authorization: 'Bearer private-gateway-key' },
    ]);
    assert.doesNotMatch(
      JSON.stringify(relay.observations),
      /private-gateway-key|private-client-key|private-fixture-marker|Read the controlled file/,
    );
    unsafe = true;
    const blocked = await fetch(`${relay.baseUrl}/v1/responses`, { method: 'POST', body });
    assert.equal(blocked.status, 502);
    assert.doesNotMatch(await blocked.text(), /function_call|arguments/);
    assert.equal(relay.observations[1].blockedToolInstructions, true);
  } finally {
    await relay.close();
  }
});
