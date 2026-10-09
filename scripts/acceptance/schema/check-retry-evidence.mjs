import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { createLiveRetryRelay } from './live-retry-relay.mjs';
import { readLiveRetryEvidence, retryEvidencePasses } from './live-retry-evidence.mjs';

const body = JSON.stringify({
  request: { contents: [{ role: 'user', parts: [{ text: 'controlled-retry-marker' }] }] },
});
const options = (identity) => ({
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    authorization: `Bearer private-fixture-${identity}`,
  },
  body,
});
function address(relay, role) {
  const url = relay.baseUrls.split(',')[role === 'primary' ? 0 : 1];
  return `${url}:generateContent`;
}

test('network fault is real socket failure followed by one unchanged forwarded request', async () => {
  const forwarded = [];
  const relay = await createLiveRetryRelay({
    forward: async (url, init) => {
      forwarded.push({
        url,
        identity: init.headers.get('authorization'),
        body: init.body.toString(),
      });
      return new Response('{"controlled":true}', { status: 200 });
    },
  });
  try {
    relay.arm('network', 'controlled-retry-marker');
    await assert.rejects(fetch(address(relay, 'primary'), options('a')), /fetch failed/);
    const response = await fetch(address(relay, 'backup'), options('a'));
    await response.text();
    const observations = relay.disarm();
    assert.deepEqual(observations, [
      {
        role: 'primary',
        transportIdentityOrdinal: 1,
        contentsUnchanged: true,
        action: 'socket-reset',
      },
      {
        role: 'backup',
        transportIdentityOrdinal: 1,
        contentsUnchanged: true,
        action: 'forwarded',
        status: 200,
      },
    ]);
    assert.deepEqual(forwarded, [
      {
        url: 'https://cloudcode-pa.googleapis.com/v1internal:generateContent',
        identity: 'Bearer private-fixture-a',
        body,
      },
    ]);
    assert.doesNotMatch(
      JSON.stringify(observations),
      /private-fixture|controlled-retry-marker|authorization/,
    );
  } finally {
    await relay.close();
  }
});

test('incomplete injection forwards the identical request through the real stream route', async () => {
  const forwarded = [];
  const frame =
    'data: {"response":{"candidates":[{"content":{"parts":[{"functionCall":{"name":"probe","args":{}}}]},"finishReason":"STOP"}]}}\n\n';
  const relay = await createLiveRetryRelay({
    forward: async (url, init) => {
      forwarded.push({ url, body: init.body.toString() });
      return new Response(frame, { headers: { 'content-type': 'text/event-stream' } });
    },
  });
  try {
    relay.arm('incomplete', 'controlled-retry-marker');
    const direct = await fetch(address(relay, 'primary'), options('a'));
    const fragment = await direct.json();
    assert.equal(fragment.response.candidates[0].content.parts[0].thought, true);
    assert.equal(fragment.response.candidates[0].finishReason, undefined);
    assert.equal(forwarded.length, 0);
    const stream = await fetch(
      address(relay, 'primary').replace(':generateContent', ':streamGenerateContent?alt=sse'),
      options('a'),
    );
    assert.equal(await stream.text(), frame);
    assert.deepEqual(forwarded, [
      {
        url: 'https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse',
        body,
      },
    ]);
    assert.deepEqual(
      relay.disarm().map((item) => ({ action: item.action, unchanged: item.contentsUnchanged })),
      [
        { action: 'injected-incomplete-thinking', unchanged: true },
        { action: 'forwarded', unchanged: true },
      ],
    );
    const evidence = {
      singleGatewayRequest: true,
      distinctAccounts: 1,
      attempts: [
        {
          operation: 'generate-content',
          accountOrdinal: 1,
          role: 'primary',
          status: 200,
          outcome: 'completed',
        },
        {
          operation: 'stream-generate',
          accountOrdinal: 1,
          role: 'primary',
          status: 200,
          outcome: 'completed',
        },
      ],
    };
    assert.equal(retryEvidencePasses('incomplete', evidence), true);
    assert.equal(
      retryEvidencePasses('incomplete', { ...evidence, attempts: evidence.attempts.slice(0, 1) }),
      false,
    );
    assert.equal(
      retryEvidencePasses('incomplete', {
        ...evidence,
        attempts: evidence.attempts.map((attempt) => ({
          ...attempt,
          operation: 'generate-content',
        })),
      }),
      false,
    );
  } finally {
    await relay.close();
  }
});

test('rotation faults both addresses for the first identity and forwards only the next', async () => {
  let forwardCount = 0;
  const relay = await createLiveRetryRelay({
    forward: async (_url, init) => {
      forwardCount++;
      assert.equal(init.headers.get('authorization'), 'Bearer private-fixture-b');
      return new Response('controlled', { status: 200 });
    },
  });
  try {
    relay.arm('rotation', 'controlled-retry-marker');
    for (const role of ['primary', 'backup']) {
      const response = await fetch(address(relay, role), options('a'));
      assert.equal(response.status, 503);
      await response.text();
    }
    const response = await fetch(address(relay, 'primary'), options('b'));
    assert.equal(response.status, 200);
    await response.text();
    assert.equal(forwardCount, 1);
    const observed = relay.disarm();
    assert.deepEqual(
      observed.map(({ action, transportIdentityOrdinal }) => ({
        action,
        transportIdentityOrdinal,
      })),
      [
        { action: 'injected-503', transportIdentityOrdinal: 1 },
        { action: 'injected-503', transportIdentityOrdinal: 1 },
        { action: 'forwarded', transportIdentityOrdinal: 2 },
      ],
    );
    assert.ok(observed.every((item) => item.contentsUnchanged));
    assert.doesNotMatch(
      JSON.stringify(observed),
      /private-fixture|controlled-retry-marker|authorization/,
    );
  } finally {
    await relay.close();
  }
});

test('armed faults cannot affect unrelated requests', async () => {
  let forwarded = 0;
  const relay = await createLiveRetryRelay({
    forward: async () => {
      forwarded++;
      return new Response('controlled', { status: 200 });
    },
  });
  try {
    relay.arm('network', 'controlled-retry-marker');
    const response = await fetch(address(relay, 'primary'), {
      ...options('a'),
      body: body.replace('controlled-retry-marker', 'unrelated'),
    });
    assert.equal(response.status, 200);
    await response.text();
    await assert.rejects(fetch(address(relay, 'primary'), options('a')), /fetch failed/);
    assert.equal(forwarded, 1);
    assert.equal(relay.disarm().length, 1);
  } finally {
    await relay.close();
  }
});

test('relay preserves the real streaming fallback route and event bytes', async () => {
  const events = 'data: {"controlled":1}\n\ndata: {"controlled":2}\n\n';
  const relay = await createLiveRetryRelay({
    forward: async (url) => {
      assert.equal(
        url,
        'https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse',
      );
      return new Response(events, { headers: { 'content-type': 'text/event-stream' } });
    },
  });
  try {
    const url = address(relay, 'primary').replace(
      ':generateContent',
      ':streamGenerateContent?alt=sse',
    );
    const response = await fetch(url, options('a'));
    assert.equal(response.headers.get('content-type'), 'text/event-stream');
    assert.equal(await response.text(), events);
  } finally {
    await relay.close();
  }
});

test('audit proves account rotation rather than address failover and excludes private context', () => {
  const database = new DatabaseSync(':memory:');
  try {
    database.exec(
      'CREATE TABLE request_logs (id TEXT,request_headers TEXT); CREATE TABLE upstream_attempts (parent_id TEXT,account_id_hash TEXT,account_id TEXT,endpoint TEXT,status INTEGER,outcome TEXT,attempt_index INTEGER,operation TEXT);',
    );
    database
      .prepare('INSERT INTO request_logs VALUES (?,?)')
      .run(
        'private-parent',
        JSON.stringify({ 'x-schema-acceptance': 'controlled:rotation:history-combined-result' }),
      );
    const insert = database.prepare('INSERT INTO upstream_attempts VALUES (?,?,?,?,?,?,?,?)');
    const rows = [
      [
        'private-parent',
        'private-account-a',
        null,
        'http://127.0.0.1:1234/primary/v1internal:generateContent',
        503,
        'upstream_error',
        1,
      ],
      [
        'private-parent',
        'private-account-a',
        null,
        'http://127.0.0.1:1234/backup/v1internal:generateContent',
        503,
        'upstream_error',
        2,
      ],
      [
        'private-parent',
        'private-account-b',
        null,
        'http://127.0.0.1:1234/primary/v1internal:generateContent',
        200,
        'completed',
        3,
      ],
    ];
    for (const row of rows) {
      insert.run(...row, 'generate-content');
    }
    const evidence = readLiveRetryEvidence(database, 'controlled', 'rotation');
    assert.equal(retryEvidencePasses('rotation', evidence), true);
    assert.doesNotMatch(
      JSON.stringify(evidence),
      /private-parent|private-account|request_headers|account_id|127\.0\.0\.1/,
    );
    assert.equal(
      retryEvidencePasses('rotation', { ...evidence, singleGatewayRequest: false }),
      false,
    );
    database.exec("UPDATE upstream_attempts SET account_id_hash='private-account-a'");
    assert.equal(
      retryEvidencePasses('rotation', readLiveRetryEvidence(database, 'controlled', 'rotation')),
      false,
    );
    database.exec('UPDATE upstream_attempts SET account_id_hash=NULL');
    assert.equal(
      retryEvidencePasses('rotation', readLiveRetryEvidence(database, 'controlled', 'rotation')),
      false,
    );
    assert.equal(
      retryEvidencePasses('rotation', {
        singleGatewayRequest: false,
        distinctAccounts: 0,
        attempts: [],
      }),
      false,
    );
    const network = {
      singleGatewayRequest: true,
      distinctAccounts: 1,
      attempts: [
        { accountOrdinal: 1, role: 'primary', status: null, outcome: 'upstream_error' },
        { accountOrdinal: 1, role: 'backup', status: 200, outcome: 'completed' },
      ],
    };
    assert.equal(retryEvidencePasses('network', network), true);
    assert.equal(retryEvidencePasses('network', { ...network, distinctAccounts: 2 }), false);
    assert.equal(
      retryEvidencePasses('network', {
        ...network,
        attempts: network.attempts.map((attempt) => ({ ...attempt, outcome: 'upstream_error' })),
      }),
      false,
    );
    assert.equal(
      retryEvidencePasses('network', { ...network, attempts: network.attempts.slice(1) }),
      false,
    );
  } finally {
    database.close();
  }
});
