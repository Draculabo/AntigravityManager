import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import spawn from 'cross-spawn';
import fastify from 'fastify';
import { summarizeEvents, summarizeRequests } from './summarize.mjs';

test('report command refreshes the complete local audit window and preserves the original report', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agm-report-refresh-'));
  const server = fastify();
  const requests = [];
  const detail = {
    recordKind: 'request',
    request: {
      url: '/v1/responses',
      timestamp: 1000,
      protocol: 'openai-responses',
      status: 200,
      outcome: 'completed',
      durationMs: 20,
      mappedModel: 'fixture-model',
      physicalModel: 'fixture-model',
      clientIp: '127.0.0.1',
      inputTokens: 100,
      outputTokens: 20,
      reasoningTokens: 10,
      hasTextOutput: true,
      responsePartial: false,
    },
    attempts: [{ status: 429 }, { status: 200 }],
    bodies: [],
  };
  server.addHook('onRequest', async (request) => {
    assert.equal(request.headers.authorization, 'Bearer disposable-test-key');
    requests.push(new URL(request.url, 'http://127.0.0.1').pathname);
  });
  server.get('/internal/audit/requests', async () => ({
    items: [
      {
        id: 'fixture-request',
        model: 'fixture-model',
        protocol: 'openai-responses',
        recordKind: 'request',
        timestamp: 1000,
      },
    ],
    total: 1,
  }));
  server.get('/internal/audit/requests/:id', async () => detail);
  try {
    const gateway = await server.listen({ host: '127.0.0.1', port: 0 });
    await mkdir(path.join(root, '.antigravity-agent'));
    await writeFile(
      path.join(root, '.antigravity-agent/gui_config.json'),
      JSON.stringify({ proxy: { api_key: 'disposable-test-key' } }),
    );
    const original = JSON.stringify({
      platform: 'fixture',
      ownerDeclared: 'cli',
      client: 'codex',
      gateway,
      startedAt: 1000,
      endedAt: 1010,
      exitCode: 0,
      timedOut: false,
      artifactBytes: 1024,
      events: summarizeEvents('codex', JSON.stringify({ type: 'turn.completed' })),
      thought: { writeFailuresDelta: 0, reasoningTokensAvailable: true },
      budgets: { input: null, output: null },
      audit: summarizeRequests([]),
      verdict: { passed: false, failures: ['no-gateway-requests'] },
    });
    const reportPath = path.join(root, 'report.json');
    await writeFile(reportPath, original);
    const child = spawn(
      process.execPath,
      [fileURLToPath(new URL('./aggregate.mjs', import.meta.url)), '--refresh', root, reportPath],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let output = '';
    for (const stream of [child.stdout, child.stderr]) {
      stream.on('data', (chunk) => {
        output += chunk.toString();
      });
    }
    let exit;
    try {
      exit = await once(child, 'close', { signal: AbortSignal.timeout(15_000) });
    } finally {
      if (child.exitCode === null) {
        child.kill();
      }
    }
    assert.equal(exit[0], 0, output);
    assert.match(
      output,
      /\| fixture \| cli \| codex \| openai-responses \/v1\/responses \| PASS \| 1\/1 \| 1 \| 0 \| 100 \| 20 \| reported \| 1024 \|/,
    );
    const refreshed = JSON.parse(await readFile(path.join(root, 'report.reconciled.json'), 'utf8'));
    assert.deepEqual(
      {
        audit: refreshed.audit,
        verdict: refreshed.verdict,
        reconciliation: refreshed.reconciliation,
      },
      {
        audit: summarizeRequests([detail]),
        verdict: { passed: true, failures: [] },
        reconciliation: {
          originalReport: 'report.json',
          previousRequestCount: 0,
          completeModelWindow: true,
        },
      },
    );
    assert.equal(await readFile(reportPath, 'utf8'), original);
    assert.deepEqual(requests, [
      '/internal/audit/requests',
      '/internal/audit/requests/fixture-request',
    ]);
  } finally {
    await server.close();
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    await rm(root, { recursive: true, force: true });
  }
});
