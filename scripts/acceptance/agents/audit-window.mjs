import assert from 'node:assert/strict';
import { z } from 'zod';

const listSchema = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      model: z.string().nullable(),
      protocol: z.string(),
      recordKind: z.string(),
      timestamp: z.number(),
    }),
  ),
  total: z.number().int().nonnegative(),
});
const detailSchema = z.object({
  recordKind: z.literal('request'),
  request: z.object({
    url: z.string(),
    timestamp: z.number().int().nonnegative(),
    protocol: z.string(),
    status: z.number().nullable(),
    outcome: z.string(),
    durationMs: z.number().nullable(),
    mappedModel: z.string().nullable(),
    physicalModel: z.string().nullable(),
    clientIp: z.string().nullable(),
    inputTokens: z.number().nullable(),
    outputTokens: z.number().nullable(),
    reasoningTokens: z.number().nullable(),
    hasTextOutput: z.boolean().nullable(),
    responsePartial: z.boolean(),
  }),
  attempts: z.array(z.object({ status: z.number().nullable() })),
  bodies: z.array(
    z.object({
      ownerKind: z.string(),
      direction: z.string(),
      logicalBytes: z.number(),
      state: z.string(),
    }),
  ),
});

export async function collectAuditWindow({ getJson, startedAt, endedAt, protocol }) {
  const items = [];
  for (let offset = 0; offset < 1000; offset += 200) {
    const query = new URLSearchParams({
      trafficClass: 'model',
      from: String(startedAt - 2000),
      to: String(endedAt + 2000),
      limit: '200',
      offset: String(offset),
    });
    const page = await getJson(`/internal/audit/requests?${query}`, listSchema);
    assert(page.total <= 1000, 'Model audit window exceeds the supported record limit');
    items.push(
      ...page.items.filter((item) => item.recordKind === 'request' && item.protocol === protocol),
    );
    if (offset + page.items.length >= page.total) {
      const details = [];
      // Large parallel reads can overwhelm the local owner while it audits these diagnostics.
      for (const item of items) {
        details.push(
          await getJson(`/internal/audit/requests/${encodeURIComponent(item.id)}`, detailSchema),
        );
      }
      details.sort((left, right) => left.request.timestamp - right.request.timestamp);
      return { items, details };
    }
    assert.equal(page.items.length, 200, 'Audit pagination cannot skip records');
  }
  throw new Error('Audit window could not be collected completely');
}
