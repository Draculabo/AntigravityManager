import { describe, expect, it } from 'vitest';
import { IncrementalSseRedactor } from '@/modules/proxy-gateway/audit/incremental-sse-redactor';
import { MAX_AUDIT_BODY_BYTES } from '@/modules/proxy-gateway/audit/audit-sanitizer';

describe('incremental SSE shadow pressure', () => {
  it('preserves CRLF framing and Unicode redaction across every possible two-part split', () => {
    const wire =
      'event: message\r\ndata: ' +
      JSON.stringify({ text: 'Unicode 世界😀', access_token: 'synthetic-secret' }) +
      '\r\n\r\ndata: [DONE]\r\n\r\n';
    const buffer = Buffer.from(wire);
    const baseline = new IncrementalSseRedactor();
    const expected = [...baseline.push(buffer), ...baseline.finish().chunks].join('');
    for (let split = 1; split < buffer.length; split++) {
      const redactor = new IncrementalSseRedactor();
      const actual = [
        ...redactor.push(buffer.subarray(0, split)),
        ...redactor.push(buffer.subarray(split)),
        ...redactor.finish().chunks,
      ].join('');
      expect(actual).toBe(expected);
      expect(actual).not.toContain('synthetic-secret');
    }
  });
  it('rejects an oversized unterminated line before retaining more than the event limit', () => {
    const redactor = new IncrementalSseRedactor();
    const prefix = 'data: {"access_token":"synthetic-secret","text":"';
    const oversized = prefix + 'x'.repeat(MAX_AUDIT_BODY_BYTES);
    const output = redactor.push(oversized);
    expect(output.length).toBeGreaterThan(0);
    expect(output.join('')).not.toContain('synthetic-secret');
    const finished = redactor.finish();
    expect(finished.result).toEqual({
      errorSummary: 'SSE event exceeds the incremental JSON event limit',
      parseErrorOffset: 0,
      terminalEventSeen: false,
    });
    expect(finished.chunks.join('').length).toBeLessThan(1024);
  }, 20_000);

  it('discards credential fragments through the oversized event boundary and resumes later valid events', () => {
    const redactor = new IncrementalSseRedactor();
    const output = [
      ...redactor.push('data: ' + 'x'.repeat(MAX_AUDIT_BODY_BYTES)),
      ...redactor.push('secret-fragment\n'),
      ...redactor.push('data: {"access_token":"another-secret"}\n\n'),
      ...redactor.push('data: {"text":"later valid"}\n\n'),
      ...redactor.finish().chunks,
    ].join('');
    expect(output).not.toContain('secret-fragment');
    expect(output).not.toContain('another-secret');
    expect(output).toContain('later valid');
    expect(output.match(/sse_event_limit/gu)).toHaveLength(1);
  }, 20_000);
});
