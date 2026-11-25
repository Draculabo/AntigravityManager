import { expect, it, vi } from 'vitest';
import { readAuditContextComposition } from '@/modules/proxy-gateway/traffic-monitor/audit-context-composition';
import { readTrafficRequestCsv } from '@/modules/proxy-gateway/traffic-monitor/traffic-request-csv';
import type {
  TrafficAuditSummary,
  TrafficAuditListResult,
} from '@/modules/proxy-gateway/audit/traffic-audit.types';

it('classifies retained prompt sections without substituting byte estimates for token counts', () => {
  const contents = JSON.stringify({
    system: 'instructions',
    tools: [{ name: 'run' }],
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: '中文' },
          { type: 'image_url', image_url: 'redacted' },
        ],
      },
      { role: 'tool', content: 'result' },
    ],
  });
  const sizes = readAuditContextComposition(contents);
  expect(sizes).toEqual({
    system: 14,
    tools: 16,
    skills: 0,
    memory: 0,
    attachments: 43,
    results: 8,
    conversation: 31,
  });
  expect(readAuditContextComposition('{"input":')).toBeNull();
  expect(readAuditContextComposition('{"metadata":{"token_count":77}}')).toBeNull();
});

const request: TrafficAuditSummary = {
  id: 'fixed-request',
  attributedAccountId: null,
  completedAt: 1000,
  durationMs: 20,
  hasImageOutput: false,
  hasTextOutput: true,
  inputTokens: 10,
  outputTokens: 2,
  mappedModel: null,
  model: '=SUM(1,2)',
  physicalModel: 'a"b',
  physicalModelFamily: 'a',
  method: 'POST',
  outcome: 'completed',
  protocol: 'anthropic',
  recordKind: 'request',
  status: 200,
  timestamp: 1000,
  trafficClass: 'model',
  url: 'https://private.example/?key=excluded',
};

it('exports matching pages as formula-safe CSV without URLs and rejects a changed ledger', async () => {
  const input = { limit: 10, offset: 12, protocol: 'anthropic', to: 2000, from: 500 };
  const read = vi
    .fn<() => Promise<TrafficAuditListResult>>()
    .mockResolvedValueOnce({ total: 2, items: [request] })
    .mockResolvedValueOnce({ total: 2, items: [{ ...request, id: 'second' }] });
  const csv = (await readTrafficRequestCsv(read, input, new AbortController().signal)).join('');
  expect(csv).toContain(`"'=SUM(1,2)","a""b"`);
  expect(csv).not.toContain('private.example');
  expect(read.mock.calls).toEqual([
    [{ ...input, limit: 100, offset: 0 }],
    [{ ...input, limit: 100, offset: 1 }],
  ]);
  read.mockReset().mockResolvedValue({ total: 2, items: [request] });
  await expect(readTrafficRequestCsv(read, input, new AbortController().signal)).rejects.toThrow(
    'traffic-change',
  );
});
