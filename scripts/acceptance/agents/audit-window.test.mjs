import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { collectAuditWindow } from './audit-window.mjs';

const options = { startedAt: 3000, endedAt: 5000, model: 'test-model', protocol: 'openai' };
const detail = {
  recordKind: 'request',
  request: {
    url: '/v1/chat/completions',
    timestamp: 4000,
    protocol: 'openai',
    status: 200,
    outcome: 'completed',
    durationMs: 20,
    mappedModel: 'test-model',
    physicalModel: 'test-model',
    clientIp: '127.0.0.1',
    inputTokens: 10,
    outputTokens: 5,
    reasoningTokens: null,
    hasTextOutput: true,
    responsePartial: false,
  },
  attempts: [{ status: 200 }],
  bodies: [],
};
const row = (index) => ({
  id: `request-${index}`,
  model: 'test-model',
  protocol: 'openai',
  recordKind: 'request',
  timestamp: 4000,
});

test('model-only audit pagination includes every task request and ignores other protocols', async () => {
  const routes = [];
  const result = await collectAuditWindow({
    ...options,
    getJson: async (route, schema) => {
      routes.push(route);
      if (route.includes('?')) {
        const query = new URL(route, 'http://127.0.0.1').searchParams;
        assert.equal(query.get('trafficClass'), 'model');
        assert.equal(query.get('from'), '1000');
        assert.equal(query.get('to'), '7000');
        const offset = Number(query.get('offset'));
        const items =
          offset === 0
            ? Array.from({ length: 200 }, (_, i) => ({ ...row(i), protocol: 'anthropic' }))
            : [row(200)];
        return schema.parse({ items, total: 201 });
      }
      return schema.parse(detail);
    },
  });
  assert.deepEqual(result, { items: [row(200)], details: [detail] });
  assert.equal(routes.length, 3);
});

test('an oversized audit window fails instead of producing a truncated passing report', async () => {
  await assert.rejects(
    collectAuditWindow({
      ...options,
      getJson: async (_route, schema) =>
        schema.parse({ items: Array.from({ length: 200 }, (_, i) => row(i)), total: 1001 }),
    }),
    /exceeds the supported record limit/,
  );
});

test('automatic review requests using another model remain in the client task window', async () => {
  const main = row(0);
  const review = { ...row(1), model: 'review-model' };
  const reviewDetail = {
    ...detail,
    request: { ...detail.request, mappedModel: 'review-model', physicalModel: 'review-model' },
  };
  const result = await collectAuditWindow({
    ...options,
    getJson: async (route, schema) => {
      if (route.includes('?')) {
        return schema.parse({ items: [main, review], total: 2 });
      }
      return schema.parse(route.endsWith(review.id) ? reviewDetail : detail);
    },
  });
  assert.deepEqual(result, { items: [main, review], details: [detail, reviewDetail] });
});

test('an incomplete page fails instead of skipping the missing records', async () => {
  await assert.rejects(
    collectAuditWindow({
      ...options,
      getJson: async (_route, schema) => schema.parse({ items: [row(0)], total: 201 }),
    }),
    /cannot skip records/,
  );
});

test('large client windows bound diagnostic concurrency and retain every detail', async () => {
  const items = Array.from({ length: 64 }, (_, i) => row(i));
  let active = 0;
  let peak = 0;
  const result = await collectAuditWindow({
    ...options,
    getJson: async (route, schema) => {
      if (route.includes('?')) {
        return schema.parse({ items, total: items.length });
      }
      active += 1;
      peak = Math.max(peak, active);
      await setImmediate();
      active -= 1;
      return schema.parse(detail);
    },
  });
  assert.deepEqual(result, { items, details: items.map(() => detail) });
  assert(peak <= 4, 'Diagnostic requests must not overwhelm the live owner');
});
