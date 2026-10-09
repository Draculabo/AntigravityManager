import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  PartProcessor,
  StreamingState,
} from '@/modules/proxy-gateway/antigravity/ClaudeStreamingMapper';
import { SignatureStore } from '@/modules/proxy-gateway/antigravity/SignatureStore';

const context = { model: 'gemini-pro-agent', sessionKey: 'final-answer-probe', messageCount: 2 };
const signature = 'controlled-final-answer-thought-signature';
const answer = 'controlled-tool-result';

function events(chunks: string[]) {
  return chunks
    .join('')
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => z.record(z.string(), z.unknown()).parse(JSON.parse(line.slice(6))));
}

const terminal = [
  {
    type: 'message_delta',
    delta: { stop_reason: 'end_turn', stop_sequence: null },
    usage: { input_tokens: 0, output_tokens: 0 },
  },
  { type: 'message_stop' },
];

describe('Claude stream final-answer compatibility', () => {
  afterEach(() => SignatureStore.clear());

  it.each(['attached', 'preceding'] as const)(
    'carries a %s signature before the final text block so Claude Code returns the answer',
    (placement) => {
      const state = new StreamingState(context);
      const processor = new PartProcessor(state);
      const encoded = Buffer.from(signature).toString('base64');
      const chunks =
        placement === 'attached'
          ? processor.process({ text: answer, thoughtSignature: encoded })
          : [
              ...processor.process({ text: '', thoughtSignature: encoded }),
              ...processor.process({ text: answer }),
            ];
      chunks.push(...state.emitFinish('STOP'));

      expect(events(chunks)).toEqual([
        {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'thinking', thinking: '' },
        },
        { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature } },
        { type: 'content_block_stop', index: 0 },
        { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: answer } },
        { type: 'content_block_stop', index: 1 },
        ...terminal,
      ]);
      expect(SignatureStore.getAt(context)).toBe(signature);
    },
  );

  it('retains a later signature in the session store without appending an empty client message', () => {
    const state = new StreamingState(context);
    const processor = new PartProcessor(state);
    const chunks = [
      ...processor.process({ text: answer }),
      ...processor.process({
        text: '',
        thoughtSignature: Buffer.from(signature).toString('base64'),
      }),
      ...state.emitFinish('STOP'),
    ];

    expect(events(chunks)).toEqual([
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: answer } },
      { type: 'content_block_stop', index: 0 },
      ...terminal,
    ]);
    expect(SignatureStore.getAt(context)).toBe(signature);
  });
});
