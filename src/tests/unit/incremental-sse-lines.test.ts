import { describe, expect, it } from 'vitest';
import { IncrementalSseLines } from '@/server/gateway/common/incremental-sse-lines';

describe('incremental SSE lines', () => {
  it('preserves complete lines across every split including CRLF and Unicode', () => {
    const text = 'data: {"text":"😀世界"}\r\n\ndata: [DONE]\n';
    for (let split = 0; split <= text.length; split++) {
      const lines = new IncrementalSseLines();
      expect([...lines.push(text.slice(0, split)), ...lines.push(text.slice(split))]).toEqual([
        'data: {"text":"😀世界"}\r',
        '',
        'data: [DONE]',
      ]);
    }
  });
  it('charges unfinished fragments before retaining them and clears after rejection', () => {
    const lines = new IncrementalSseLines(140);
    expect([...lines.push('abc')]).toEqual([]);
    expect([...lines.push('de')]).toEqual([]);
    expect(() => [...lines.push('f')]).toThrow('decode budget');
    expect([...lines.push('later\n')]).toEqual(['later']);
  });
  it('releases partial state on cancellation', () => {
    const lines = new IncrementalSseLines();
    expect([...lines.push('partial')]).toEqual([]);
    lines.clear();
    expect([...lines.push('next\n')]).toEqual(['next']);
  });

  it('flushes a near-budget line when its newline arrives in a separate empty fragment', () => {
    const lines = new IncrementalSseLines(140);
    expect([...lines.push('abc'), ...lines.push('de')]).toEqual([]);
    expect([...lines.push('\n')]).toEqual(['abcde']);
  });
});
