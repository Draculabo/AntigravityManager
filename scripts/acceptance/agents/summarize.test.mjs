import assert from 'node:assert/strict';
import test from 'node:test';

import { evaluateRun, summarizeEvents, summarizeRequests, summarizeStderr } from './summarize.mjs';

test('client startup paths and stack line numbers are not quota errors', () => {
  assert.deepEqual(
    summarizeStderr(
      'Error: Missing optional dependency\n at /var/tmp/agm-quota-20261005/codex.js:429:9',
    ),
    { argumentConflict: false, blockedByPolicy: false, network: false, quota: false },
  );
});

test('stderr quota signals require an explicit error phrase', () => {
  for (const message of [
    'QUOTA_EXHAUSTED',
    'quota exceeded',
    'exceeded your quota',
    'rate limit exceeded',
    'APIError: 429 Too Many Requests',
    'HTTP 429',
    'status=429',
  ]) {
    assert.equal(summarizeStderr(message).quota, true, message);
  }
});

function request(status, attempts, inputTokens = null, outputTokens = null) {
  return {
    request: {
      url: '/v1/responses',
      timestamp: 1,
      protocol: 'openai-responses',
      status,
      outcome: 'completed',
      durationMs: 100,
      mappedModel: 'test-model',
      physicalModel: 'test-model',
      clientIp: '127.0.0.1',
      inputTokens,
      outputTokens,
      reasoningTokens: null,
      hasTextOutput: true,
      responsePartial: false,
    },
    attempts: attempts.map((attemptStatus) => ({ status: attemptStatus })),
    bodies: [
      { ownerKind: 'parent', direction: 'request', logicalBytes: 1000, state: 'complete' },
      { ownerKind: 'parent', direction: 'response', logicalBytes: 100, state: 'complete' },
    ],
  };
}

test('a recovered upstream 429 is reported without failing the completed task', () => {
  const audit = summarizeRequests([request(200, [429, 200], 500, 20)]);
  const events = summarizeEvents(
    'codex',
    [
      JSON.stringify({
        type: 'item.completed',
        item: { type: 'file_change', status: 'completed' },
      }),
      JSON.stringify({ type: 'turn.completed' }),
    ].join('\n'),
  );
  const verdict = evaluateRun({
    exitCode: 0,
    timedOut: false,
    artifactBytes: 1024,
    events,
    audit,
    thoughtWriteFailuresDelta: 0,
    budgets: { input: 1000, output: 100 },
  });
  assert.deepEqual(
    {
      auditCount: audit.count,
      upstream429Attempts: audit.upstream429Attempts,
      inputTokens: audit.inputTokens,
      outputTokens: audit.outputTokens,
      toolStates: events.toolStates,
      verdict,
    },
    {
      auditCount: 1,
      upstream429Attempts: 1,
      inputTokens: 500,
      outputTokens: 20,
      toolStates: { 'file_change:completed': 1 },
      verdict: { passed: true, failures: [] },
    },
  );
});

test('a client can receive HTTP 200 and still fail to create the artifact', () => {
  const audit = summarizeRequests([request(200, [200], 1000, 500)]);
  const events = summarizeEvents('codex', JSON.stringify({ type: 'turn.completed' }));
  const verdict = evaluateRun({
    exitCode: 0,
    timedOut: false,
    artifactBytes: null,
    events,
    audit,
    thoughtWriteFailuresDelta: 0,
    budgets: { input: null, output: null },
  });
  assert.deepEqual(verdict, { passed: false, failures: ['artifact-missing'] });
});

test('a failed gateway request and a broken thought store remain distinct failures', () => {
  const audit = summarizeRequests([request(429, [429, 429])]);
  const events = summarizeEvents('claude', JSON.stringify({ type: 'result', is_error: true }));
  const verdict = evaluateRun({
    exitCode: 1,
    timedOut: false,
    artifactBytes: null,
    events,
    audit,
    thoughtWriteFailuresDelta: 1,
    budgets: { input: null, output: null },
  });
  assert.deepEqual(verdict.failures, [
    'client-exit',
    'client-error-event',
    'artifact-missing',
    'gateway-request-failed',
    'thought-store-write-failed',
  ]);
  assert.equal(audit.usageReported, false);
});

test('OpenCode tool completion and socket failure are reported without storing their text', () => {
  const events = summarizeEvents(
    'opencode',
    [
      JSON.stringify({
        type: 'tool_use',
        part: {
          tool: 'write',
          state: { status: 'completed', input: { filePath: '/tmp/run/workspace/todo.html' } },
        },
      }),
      JSON.stringify({
        type: 'error',
        error: { type: 'unknown', message: 'Transport: socket closed' },
      }),
    ].join('\n'),
    '/tmp/run/workspace',
  );
  assert.deepEqual(
    {
      toolStates: events.toolStates,
      writeTargets: events.writeTargets,
      errorClasses: events.errorClasses,
    },
    {
      toolStates: { 'write:completed': 1 },
      writeTargets: { inWorkspace: 1, outsideWorkspace: 0, unknown: 0 },
      errorClasses: { socket: 1, quota: 0, rateLimit: 0, other: 0 },
    },
  );
});
