import { describe, expect, it } from 'vitest';
import {
  IncrementalSseDataParser,
  parseSseDataLine,
} from '@/modules/proxy-gateway/antigravity/internal-sse';

describe('parseSseDataLine', () => {
  it('accepts a value with and without the optional space after the colon', () => {
    expect(parseSseDataLine('data: {"a":1}')).toBe('{"a":1}');
    expect(parseSseDataLine('data:{"a":1}')).toBe('{"a":1}');
  });

  it('keeps a single leading space as part of the payload only when it is a second space', () => {
    expect(parseSseDataLine('data:  {"a":1}')).toBe(' {"a":1}');
  });

  it('ignores comment lines, other fields and empty data values', () => {
    expect(parseSseDataLine(': ping')).toBeNull();
    expect(parseSseDataLine('event: message')).toBeNull();
    expect(parseSseDataLine('')).toBeNull();
    expect(parseSseDataLine('data:')).toBe('');
  });

  it('does not treat a different field name as a data field', () => {
    expect(parseSseDataLine('metadata: {"a":1}')).toBeNull();
    expect(parseSseDataLine('dataclass: x')).toBeNull();
  });
});

describe('IncrementalSseDataParser', () => {
  it('joins multiple data fields until the blank event boundary', () => {
    const parser = new IncrementalSseDataParser();

    expect(parser.pushLine('data: {"response":')).toBeNull();
    expect(parser.pushLine('data: {"candidates":[]} }')).toBeNull();
    expect(parser.pushLine('')).toBe('{"response":\n{"candidates":[]} }');
  });

  it('accepts CRLF and a complete EOF-terminated event', () => {
    const parser = new IncrementalSseDataParser();

    expect(parser.pushLine('data: {"ok":true}\r')).toBeNull();
    expect(parser.finish()).toBe('{"ok":true}');
  });

  it('ignores comments and non-data fields', () => {
    const parser = new IncrementalSseDataParser();

    expect(parser.pushLine(': keepalive')).toBeNull();
    expect(parser.pushLine('event: message')).toBeNull();
    expect(parser.pushLine('')).toBeNull();
  });

  it('rejects an event that exceeds its byte limit and clears its retained data', () => {
    const parser = new IncrementalSseDataParser(4);

    expect(() => {
      parser.pushLine('data: 12345');
    }).toThrow('SSE event exceeded the 4-byte limit');
    expect(parser.finish()).toBeNull();
  });
});
