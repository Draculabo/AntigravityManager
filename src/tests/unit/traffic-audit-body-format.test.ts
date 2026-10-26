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

  it('keeps every non-media field in concise view', () => {
    expect(JSON.parse(formatAuditBody(compact, 'json', 'concise'))).toEqual(geminiResponse);
  });

  it('keeps request inputs and tools visible while replacing only media leaves', () => {
    const request = JSON.stringify({
      model: 'gemini-3-flash',
      instructions: 'Use the provided tool.',
      input: [{ role: 'user', content: 'hello' }],
      tools: [{ name: 'search', parameters: { type: 'object' } }],
      contents: [{ parts: [{ inlineData: { mimeType: 'image/png', data: 'AAAA'.repeat(10) } }] }],
      extra: 'hidden',
    });
    const display = formatAuditBody(request, 'json', 'concise');
    expect(display).toContain('Use the provided tool.');
    expect(display).toContain('search');
    expect(display).toContain('[omitted media data: 40 UTF-8 bytes; concise view]');
    expect(display).toContain('hidden');
  });
  it('does not inherit media context into tool arguments or parse business strings', () => {
    const input = {
      model: 'fixture',
      mimeType: 'image/png',
      tools: [{ args: { data: 'business value', nested: { data: 'keep' } } }],
      custom: '{"a":1}',
    };
    expect(JSON.parse(formatAuditBody(JSON.stringify(input), 'json', 'concise'))).toEqual(input);
  });
  it('omits recognized inline media across protocols and preserves their envelopes', () => {
    const input = [
      {
        contents: [
          { parts: [{ inline_data: { mime_type: 'image/png', data: 'AAAA', extra: 'keep' } }] },
        ],
      },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'BBBB' } },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,CCCC', detail: 'high' } },
      { type: 'input_audio', input_audio: { data: 'DDDD', format: 'wav' } },
      { type: 'input_image', image_url: 'https://example.invalid/image.png' },
    ];
    const marker = '[omitted media data: 4 UTF-8 bytes; concise view]';
    expect(JSON.parse(formatAuditBody(JSON.stringify(input), 'json', 'concise'))).toEqual([
      {
        contents: [
          { parts: [{ inline_data: { mime_type: 'image/png', data: marker, extra: 'keep' } }] },
        ],
      },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: marker } },
      {
        type: 'image_url',
        image_url: { url: '[omitted media data: 26 UTF-8 bytes; concise view]', detail: 'high' },
      },
      { type: 'input_audio', input_audio: { data: marker, format: 'wav' } },
      input[4],
    ]);
    expect(JSON.parse(formatAuditBody(JSON.stringify(input), 'json', 'full'))).toEqual(input);
  });
  it('preserves incomplete JSON and raw SSE without changing offsets', () => {
    const incomplete = '{"response":{"candidates":[';
    expect(formatAuditBody(incomplete, 'json', 'full')).toBe(incomplete);
    const sse = 'event: message\ndata: {"response":1}\n\n';
    expect(formatAuditBody(sse, 'sse', 'full')).toBe(sse);
  });
  it('retains special JSON field names as own data fields', () => {
    const content = '{"model":"fixture","__proto__":{"data":"business"}}';
    expect(formatAuditBody(content, 'json', 'concise')).toBe(
      JSON.stringify(JSON.parse(content), null, 2),
    );
  });
});
