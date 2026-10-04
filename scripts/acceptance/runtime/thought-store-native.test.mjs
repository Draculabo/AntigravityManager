import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openWorker } from './diagnostic-worker-fixture.mjs';

test('production thought worker lists metadata without loading body and fetches one selected record', async () => {
  const thought = openWorker('thought', 'thought-store');
  try {
    const body = 'reasoning '.repeat(12_000);
    const saved = await thought.command('save', {
      createdAt: Date.now(),
      fingerprint: 'turn-one',
      maxSessionBytes: 64 * 1024 * 1024,
      maxSessions: 2_000,
      maxTurns: 200,
      meaningful: true,
      model: 'gemini-pro-agent',
      sessionKey: 'session-one',
      signature: 'signature-one',
      sourceFamily: 'gemini',
      thought: body,
      toolIds: [],
      toolNames: [],
      visible: 'answer',
    });
    const id = saved.id;
    assert.ok(id > 0);
    const summaries = await thought.command('listRecords', { sessionKey: 'session-one' });
    assert.equal(summaries.length, 1);
    assert.equal(summaries[0].id, id);
    assert.equal(summaries[0].thoughtBytes, Buffer.byteLength(body));
    assert.equal(Object.hasOwn(summaries[0], 'thought'), false);
    assert.equal(Object.hasOwn(summaries[0], 'signature'), false);
    const matchingSessions = await thought.command('listSessions', {
      limit: 10,
      model: 'gemini-pro',
      offset: 0,
      search: 'session-',
    });
    assert.deepEqual(matchingSessions, [
      {
        bytes: Buffer.byteLength(body),
        endedAt: null,
        lastAccessed: matchingSessions[0].lastAccessed,
        recordCount: 1,
        sessionKey: 'session-one',
      },
    ]);
    assert.deepEqual(
      await thought.command('listSessions', { limit: 10, model: 'claude', offset: 0 }),
      [],
    );
    const detail = await thought.command('getRecord', { id, sessionKey: 'session-one' });
    assert.equal(detail.thought, body);
    assert.equal(await thought.command('getRecord', { id, sessionKey: 'another-session' }), null);
  } finally {
    await thought.close();
  }
});

test('production thought worker ingests repeated history without duplicating turns and upgrades older thought', async () => {
  const thought = openWorker('thought-history', 'thought-store');
  const sessionKey = 'history-session';
  const record = (fingerprint, text) => ({
    createdAt: Date.now(),
    fingerprint,
    maxSessionBytes: 64 * 1024 * 1024,
    maxSessions: 2_000,
    maxTurns: 200,
    meaningful: true,
    model: 'gemini-pro-agent',
    sessionKey,
    signature: null,
    sourceFamily: 'gemini-pro',
    thought: text,
    toolIds: [],
    toolNames: [],
    visible: fingerprint,
  });
  try {
    await thought.command('save', record('first', 'short'));
    await thought.command('save', record('second', 'second thought'));
    const history = [
      record('first', 'expanded full first thought'),
      record('second', 'second thought'),
      record('third', 'third thought'),
    ];
    await thought.command('ingestHistory', { records: history, sessionKey });
    await thought.command('ingestHistory', { records: history, sessionKey });
    const stored = await thought.command('getSession', { sessionKey });
    assert.deepEqual(
      stored.map((item) => item.fingerprint),
      ['first', 'second', 'third'],
    );
    assert.deepEqual(
      stored.map((item) => item.thought),
      ['expanded full first thought', 'second thought', 'third thought'],
    );
  } finally {
    await thought.close();
  }
});

test('production thought worker prunes older sessions through the Drizzle subquery', async () => {
  const thought = openWorker('thought-session-prune', 'thought-store');
  const first = Date.now() - 1_000;
  try {
    for (const [sessionKey, createdAt] of [
      ['older-session', first],
      ['newer-session', first + 1],
    ]) {
      await thought.command('save', {
        createdAt,
        fingerprint: sessionKey,
        maxSessionBytes: 64 * 1024 * 1024,
        maxSessions: 1,
        maxTurns: 200,
        meaningful: true,
        model: 'gemini-pro-agent',
        sessionKey,
        signature: null,
        sourceFamily: 'gemini',
        thought: sessionKey,
        toolIds: [],
        toolNames: [],
        visible: sessionKey,
      });
    }
    const sessions = await thought.command('listSessions', { limit: 10, offset: 0 });
    assert.deepEqual(
      sessions.map((session) => session.sessionKey),
      ['newer-session'],
    );
  } finally {
    await thought.close();
  }
});
