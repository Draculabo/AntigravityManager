import { describe, expect, it } from 'vitest';

import {
  createDiagnosticErrorRecord,
  splitDiagnosticText,
} from '@/shared/observability/errorDiagnostic';

describe('structured error diagnostics', () => {
  it('keeps every stack frame while redacting credentials and local user paths', () => {
    const cause = new Error('upstream Bearer secret');
    cause.stack =
      'Error: upstream Bearer secret\n    at inner (C:\\Users\\alice\\work\\file.ts:2:3)';
    const error = new Error('decode failed at https://user:pass@example.test?access_token=abc');
    error.stack =
      'Error: decode failed at https://user:pass@example.test?access_token=abc\n' +
      '    at decode (C:\\Users\\alice\\work\\file.ts:10:11)\n' +
      '    at async run (C:\\project\\gateway.ts:20:21)';
    Object.defineProperty(error, 'cause', { value: cause, enumerable: false });

    const record = createDiagnosticErrorRecord({
      error,
      source: 'proxy-gateway',
      category: 'decode-error',
      module: 'internal-sse',
      functionName: 'decodeEvent',
      stage: 'decode-event',
      protocol: 'openai-chat',
      requestId: 'request-1',
      attemptId: 'attempt-1',
    });

    expect(record.stack).toContain('decode (C:\\Users\\***\\work\\file.ts:10:11)');
    expect(record.stack).toContain('at async run (C:\\project\\gateway.ts:20:21)');
    expect(record.stack).not.toContain('access_token=abc');
    expect(record.stack).not.toContain('user:pass');
    expect(record.causes[0]).toMatchObject({ name: 'Error', cycle: false });
    expect(record.causes[0]?.stack).toContain('C:\\Users\\***');
    expect(record.stackComplete).toBe(true);
  });

  it('splits large stacks without changing their content', () => {
    const stack = '帧'.repeat(70_000) + '\n    at async final (file.ts:1:2)';
    const chunks = splitDiagnosticText(stack, 64 * 1024);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => Buffer.byteLength(chunk, 'utf8') <= 64 * 1024)).toBe(true);
    expect(chunks.join('')).toBe(stack);
  });

  it('marks a cause cycle instead of walking it forever', () => {
    const first = new Error('first');
    const second = new Error('second');
    Object.defineProperty(first, 'cause', { value: second });
    Object.defineProperty(second, 'cause', { value: first });
    const record = createDiagnosticErrorRecord({
      error: first,
      source: 'test',
      category: 'unknown',
    });
    expect(record.causes.at(-1)).toMatchObject({ cycle: true });
  });
});
