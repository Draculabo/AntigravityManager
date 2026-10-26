import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  PartProcessor,
  StreamingState,
} from '@/modules/proxy-gateway/antigravity/ClaudeStreamingMapper';
import { SignatureStore } from '@/modules/proxy-gateway/antigravity/SignatureStore';

const context = { model: 'gemini-pro-agent', sessionKey: 'stream-block-owner', messageCount: 2 };
const signatureA = 'first-complete-signature'.repeat(3);
const signatureB = 'short-complete-signature';
const Event = z
  .object({
    type: z.string(),
    index: z.number().optional(),
    delta: z
      .object({ type: z.string().optional(), signature: z.string().optional() })
      .loose()
      .optional(),
  })
  .loose();

function events(chunks: string[]) {
  return chunks.flatMap((chunk) =>
    chunk
      .split('\n')
      .filter((line) => line.startsWith('data: '))
      .map((line) => Event.parse(JSON.parse(line.slice(6)))),
  );
}

afterEach(() => SignatureStore.clear());

describe('Claude stream signature block ownership', () => {
  it('attaches a textless signature-only part to its currently open thought block', () => {
    const state = new StreamingState(context);
    const processor = new PartProcessor(state);
    const output = events([
      ...processor.process({ thought: true, text: 'reasoning' }),
      ...processor.process({ thoughtSignature: signatureA }),
      ...state.emitFinish('STOP'),
    ]);
    expect(output.filter((event) => event.delta?.type === 'signature_delta')).toEqual([
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'signature_delta', signature: signatureA },
      },
    ]);
    expect(output.filter((event) => event.type === 'content_block_start')).toHaveLength(1);
    expect(SignatureStore.getAt(context)).toBe(signatureA);
  });

  it('accepts the last complete value of the current block even when it is shorter', () => {
    const state = new StreamingState(context);
    const processor = new PartProcessor(state);
    const output = events([
      ...processor.process({ thought: true, text: 'reasoning', thoughtSignature: signatureA }),
      ...processor.process({ thought: true, text: '', thoughtSignature: signatureB }),
      ...state.emitFinish('STOP'),
    ]);
    expect(output.filter((event) => event.delta?.type === 'signature_delta')).toEqual([
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'signature_delta', signature: signatureB },
      },
    ]);
    expect(SignatureStore.getAt(context)).toBe(signatureB);
  });

  it('does not publish a pending thought-block signature before the block closes', () => {
    const state = new StreamingState(context);
    const processor = new PartProcessor(state);
    processor.process({ thought: true, text: 'unfinished', thoughtSignature: signatureA });
    expect(SignatureStore.getAt(context)).toBeNull();
    state.emitFinish('STOP');
    expect(SignatureStore.getAt(context)).toBe(signatureA);
  });

  it('closes a pending signature carrier before opening the next tool block', () => {
    const state = new StreamingState(context);
    const processor = new PartProcessor(state);
    const output = events([
      ...processor.process({ text: '', thoughtSignature: signatureA }),
      ...processor.process({ functionCall: { id: 'tool-1', name: 'read', args: {} } }),
    ]);
    expect(output.map(({ type, index }) => ({ type, index }))).toEqual([
      { type: 'content_block_start', index: 0 },
      { type: 'content_block_delta', index: 0 },
      { type: 'content_block_delta', index: 0 },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1 },
      { type: 'content_block_delta', index: 1 },
      { type: 'content_block_stop', index: 1 },
    ]);
  });

  it('discards the pending signature of a corrupted thought block', () => {
    const state = new StreamingState(context);
    const processor = new PartProcessor(state);
    processor.process({ thought: true, text: 'unfinished', thoughtSignature: signatureA });
    const output = events(state.handleParseError('broken JSON'));
    expect(output).toEqual([{ type: 'content_block_stop', index: 0 }]);
    expect(SignatureStore.getAt(context)).toBeNull();
  });

  it('preserves a textless trailing signature without appending an empty final message', () => {
    const state = new StreamingState(context);
    const processor = new PartProcessor(state);
    const output = events([
      ...processor.process({ text: 'answer' }),
      ...processor.process({ thoughtSignature: signatureA }),
      ...state.emitFinish('STOP'),
    ]);
    expect(output.filter((event) => event.delta?.type === 'signature_delta')).toEqual([]);
    expect(output.filter((event) => event.type === 'content_block_start')).toHaveLength(1);
    expect(SignatureStore.getAt(context)).toBe(signatureA);
  });
});
