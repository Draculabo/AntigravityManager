import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { openWorker } from './diagnostic-worker-fixture.mjs';

for (const [operation, signature] of [
  ['save', 'skip_thought_signature_validator'],
  ['ingestHistory', 'c2tpcF90aG91Z2h0X3NpZ25hdHVyZV92YWxpZGF0b3I='],
]) {
  test(
    `actual worker ${operation} omits the placeholder and preserves part signatures across restart`,
    { timeout: 30000 },
    async () => {
      const name = `part-signatures-${operation}`;
      const worker = openWorker(name, 'thought-store');
      const partSignatures = [
        { kind: 'thought', position: 0, start: 0, end: 0, signature: 'empty' },
        {
          kind: 'thought',
          position: 1,
          start: 0,
          end: 'reasoning 中😀  '.length,
          signature: 'reasoning',
        },
        {
          kind: 'tool',
          position: 2,
          callId: 'a',
          name: 'read',
          argsDigest: createHash('sha256').update('a').digest('hex'),
          signature: 'A',
        },
        {
          kind: 'tool',
          position: 3,
          callId: 'b',
          name: 'read',
          argsDigest: createHash('sha256').update('b').digest('hex'),
          signature: 'B'.repeat(60),
        },
      ];
      const input = {
        createdAt: 1,
        fingerprint: 'parallel',
        model: 'gemini-pro-agent',
        signature,
        partSignatures,
        sourceFamily: 'gemini-pro',
        thought: 'reasoning 中😀  ',
        toolIds: ['a', 'b'],
        toolNames: ['read'],
        visible: '',
        meaningful: true,
        sessionKey: 'parallel',
        maxSessionBytes: 1024 * 1024,
        maxSessions: 10,
        maxTurns: 10,
      };
      try {
        await worker.command(
          operation,
          operation === 'save'
            ? input
            : {
                sessionKey: input.sessionKey,
                records: [input],
              },
        );
      } finally {
        await worker.close();
      }
      const reopened = openWorker(name, 'thought-store');
      try {
        const records = await reopened.command('getSession', { sessionKey: input.sessionKey });
        const expected = [
          {
            createdAt: 1,
            fingerprint: input.fingerprint,
            id: 1,
            model: input.model,
            signature: null,
            partSignatures,
            sourceFamily: input.sourceFamily,
            thought: input.thought,
            toolIds: input.toolIds,
            toolNames: input.toolNames,
            visible: '',
            oversized: false,
            oversizedBytes: null,
            oversizedSha256: null,
          },
        ];
        assert.deepEqual(records, expected);
        assert.deepEqual(await reopened.command('load', { sessionKey: input.sessionKey }), [
          {
            ...expected[0],
            partSignatures: partSignatures.map((part) =>
              part.kind === 'tool' ? { ...part, signature: null } : part,
            ),
          },
        ]);
        await assert.rejects(reopened.command('save', { ...input, partSignatures: undefined }));
        assert.deepEqual(
          await reopened.command('getSession', { sessionKey: input.sessionKey }),
          expected,
        );
      } finally {
        await reopened.close();
      }
    },
  );
}
