import assert from 'node:assert/strict';
import { test } from 'node:test';
import { withAcceptanceDeadline } from './process-actions.mjs';

test('a stalled browser observation fails with a bounded, reportable timeout', async () => {
  await assert.rejects(
    withAcceptanceDeadline(() => new Promise(() => {}), 10),
    {
      code: 'acceptance-operation-timeout',
    },
  );
});

test('the observation deadline preserves actual results and original failures', async () => {
  assert.deepEqual(await withAcceptanceDeadline(async () => ({ confirmed: true })), {
    confirmed: true,
  });
  const original = new Error('fixture observation failed');
  await assert.rejects(
    withAcceptanceDeadline(async () => {
      throw original;
    }),
    (error) => error === original,
  );
});
