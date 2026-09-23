import { describe, expect, it } from 'vitest';

import { formatAuditBody } from '@/modules/proxy-gateway/traffic-monitor/format-audit-body';

describe('traffic audit body display formatting', () => {
  const geminiResponse = {
    response: {
      candidates: [
        { content: { parts: [{ thought: true, text: 'first\n\nsecond' }, { text: 'OK' }] } },
      ],
      modelVersion: 'gemini-3.7-flash',
    },
    traceId: 'trace-1',
    metadata: {},
    extraField: 'only in full view',
  };
  const compact = JSON.stringify(geminiResponse);

  it('pretty-prints the complete Gemini response instead of leaving it on one line', () => {
    expect(formatAuditBody(compact, 'json', 'full')).toBe(JSON.stringify(geminiResponse, null, 2));
    expect(formatAuditBody(compact, 'text', 'full')).toBe(JSON.stringify(geminiResponse, null, 2));
  });

  it('keeps Gemini response data in concise view while dropping unrelated fields', () => {
    expect(formatAuditBody(compact, 'json', 'concise')).toBe(
      JSON.stringify(
        { response: geminiResponse.response, traceId: 'trace-1', metadata: {} },
        null,
        2,
      ),
    );
  });

  it('preserves incomplete JSON and raw SSE without changing offsets', () => {
    const incomplete = '{"response":{"candidates":[';
    expect(formatAuditBody(incomplete, 'json', 'full')).toBe(incomplete);
    const sse = 'event: message\ndata: {"response":1}\n\n';
    expect(formatAuditBody(sse, 'sse', 'full')).toBe(sse);
  });
});
