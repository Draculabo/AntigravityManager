import { z } from 'zod';
import { expect, it, vi } from 'vitest';
import { auditHarForExport } from '@/modules/proxy-gateway/audit/audit-har-export';
import { snapshotAuditPayload } from '@/modules/proxy-gateway/audit/audit-sanitizer';
import { syntheticHarBody, syntheticHarDetail } from '../support/audit-har-fixture';
import type { TrafficAuditDetail } from '@/modules/proxy-gateway/audit/traffic-audit.types';

const capture = z.object({
  state: z.string(),
  representation: z.string().optional(),
  partial: z.boolean().optional(),
});
const body = z.object({ mimeType: z.string(), text: z.string().optional(), _agm: capture });
const harSchema = z.object({
  log: z.object({
    version: z.literal('1.2'),
    creator: z.object({ name: z.string(), version: z.string() }),
    entries: z.array(
      z.object({
        startedDateTime: z.iso.datetime(),
        time: z.number().nonnegative(),
        request: z.object({
          method: z.string(),
          url: z.url(),
          headers: z.array(z.object({ name: z.string(), value: z.string() })),
          postData: body,
        }),
        response: z.object({ status: z.number(), content: body }),
        timings: z.object({
          blocked: z.number(),
          dns: z.number(),
          connect: z.number(),
          send: z.number(),
          wait: z.number(),
          receive: z.number(),
          ssl: z.number(),
        }),
        _agm: z.object({
          kind: z.enum(['parent', 'attempt']),
          durationMs: z.number().nullable(),
          originKnown: z.boolean(),
          methodKnown: z.boolean(),
        }),
      }),
    ),
  }),
});

async function collect(source: Parameters<typeof auditHarForExport>[1], id: string) {
  let text = '';
  for await (const part of auditHarForExport(id, source)) {
    text += part;
  }
  return text;
}

it('redacts Gemini query keys from legacy stored URLs in HAR without altering unrelated query values', async () => {
  const detail = syntheticHarDetail();
  detail.request.url = '/v1beta/models?key=inbound-secret&k%65y=duplicate-secret&alt=sse';
  detail.attempts[0].endpoint =
    'https://provider.example.test/v1beta/models?%6b%65%79=upstream-secret&alt=sse';
  const text = await collect(
    { detail: async () => detail, body: async function* () {} },
    detail.request.id,
  );
  expect(text).not.toMatch(/inbound-secret|duplicate-secret|upstream-secret/);
  const har = harSchema.parse(JSON.parse(text));
  expect(har.log.entries.map((entry) => [...new URL(entry.request.url).searchParams])).toEqual([
    [
      ['key', '[REDACTED]'],
      ['alt', 'sse'],
    ],
    [
      ['key', '[REDACTED]'],
      ['alt', 'sse'],
    ],
  ]);
});

it('exports real inbound and upstream exchanges with separate sanitized bodies and unknown transport phases', async () => {
  const detail = syntheticHarDetail();
  const parentText = snapshotAuditPayload({
    api_key: 'secret',
    prompt: '客户端🙂\n"quoted"\\',
  }).text!;
  const upstreamText = '{"contents":["transformed"]}';
  const parentBody = syntheticHarBody(detail.request.id, 'parent', parentText);
  const upstreamBody = syntheticHarBody(detail.attempts[0].id, 'attempt', upstreamText);
  detail.bodies = [parentBody, upstreamBody];
  const source = {
    detail: async () => detail,
    body: async function* (id: string) {
      const content = id === parentBody.id ? parentText : upstreamText;
      for (let index = 0; index < content.length; index += 1) {
        yield content[index];
      }
    },
  };
  const text = await collect(source, detail.request.id);
  expect(text).not.toContain('secret');
  const har = harSchema.parse(JSON.parse(text));
  expect(har.log.entries).toHaveLength(2);
  const [inbound, upstream] = har.log.entries;
  expect(inbound.request.postData.text).toBe(parentText);
  expect(upstream.request.postData.text).toBe(upstreamText);
  expect(inbound._agm).toEqual({
    kind: 'parent',
    durationMs: 10000,
    originKnown: false,
    methodKnown: true,
  });
  expect(upstream._agm).toEqual({
    kind: 'attempt',
    durationMs: 8000,
    originKnown: true,
    methodKnown: false,
  });
  expect(upstream.request.method).toBe('');
  expect(inbound.request.headers).toEqual([{ name: 'authorization', value: '[REDACTED]' }]);
  expect(upstream.request.headers).toEqual([{ name: 'x-api-key', value: '[REDACTED]' }]);
  expect(upstream.timings).toEqual({
    blocked: -1,
    dns: -1,
    connect: -1,
    send: -1,
    wait: -1,
    receive: -1,
    ssl: -1,
  });
  expect(upstream.time).toBe(8000);
});

it('keeps a zero-attempt request as one entry and missing or expired capture explicit', async () => {
  const detail = syntheticHarDetail();
  detail.attempts = [];
  const expired = {
    ...syntheticHarBody(detail.request.id, 'parent', 'expired'),
    state: 'expired' as const,
  };
  detail.bodies = [expired];
  const read = vi.fn(async function* () {
    yield 'must not export';
  });
  const har = harSchema.parse(
    JSON.parse(await collect({ detail: async () => detail, body: read }, detail.request.id)),
  );
  expect(har.log.entries).toHaveLength(1);
  expect(har.log.entries[0].request.postData).toEqual({
    mimeType: 'application/json',
    _agm: { state: 'expired', representation: 'sanitized_json', partial: false },
  });
  expect(har.log.entries[0].response.content).toEqual({
    mimeType: 'text/plain',
    _agm: { state: 'not-captured' },
  });
  expect(read).not.toHaveBeenCalled();
});

it('preserves partial reconstructed SSE as a stored representation', async () => {
  const detail = syntheticHarDetail();
  detail.bodies = [
    {
      ...syntheticHarBody(detail.request.id, 'parent', '{}'),
      direction: 'response',
      representation: 'reconstructed_sse',
      state: 'incomplete',
      partial: true,
    },
  ];
  const har = harSchema.parse(
    JSON.parse(
      await collect(
        {
          detail: async () => detail,
          body: async function* () {
            yield '{}';
          },
        },
        detail.request.id,
      ),
    ),
  );
  expect(har.log.entries[0].response.content).toEqual({
    mimeType: 'application/json',
    text: '{}',
    _agm: { state: 'incomplete', representation: 'reconstructed_sse', partial: true },
  });
});

it.each(['missing', 'ipc', 'active', 'writing'] as const)(
  'rejects %s captures before writing content',
  async (condition) => {
    const detail = syntheticHarDetail();
    if (condition === 'ipc') {
      detail.request.trafficClass = 'ipc';
    }
    if (condition === 'active') {
      detail.request.outcome = 'in_progress';
    }
    if (condition === 'writing') {
      detail.bodies = [
        { ...syntheticHarBody(detail.request.id, 'parent', '{}'), state: 'writing' },
      ];
    }
    await expect(
      collect(
        {
          detail: async () => (condition === 'missing' ? null : detail),
          body: async function* () {},
        },
        detail.request.id,
      ),
    ).rejects.toThrow('settled');
  },
);

it('fails when the request snapshot changes while content is exported', async () => {
  const detail = syntheticHarDetail();
  const read = vi
    .fn<() => Promise<TrafficAuditDetail | null>>()
    .mockResolvedValueOnce(detail)
    .mockResolvedValueOnce(null);
  await expect(
    collect({ detail: read, body: async function* () {} }, detail.request.id),
  ).rejects.toThrow('changed');
});
