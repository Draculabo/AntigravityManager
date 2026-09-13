import { describe, it, expect, beforeEach } from 'vitest';
import {
  PartProcessor,
  StreamingState,
} from '../../modules/proxy-gateway/antigravity/ClaudeStreamingMapper';
import { transformResponse } from '../../modules/proxy-gateway/antigravity/ClaudeResponseMapper';

describe('StreamingState', () => {
  let state: StreamingState;

  beforeEach(() => {
    state = new StreamingState();
  });

  describe('handleParseError', () => {
    it('should return empty array on first error', () => {
      const chunks = state.handleParseError('invalid json');
      expect(chunks).toEqual([]);
    });

    it('should emit error event when error count exceeds 3', () => {
      // Simulate 4 parse errors
      state.handleParseError('error 1');
      state.handleParseError('error 2');
      state.handleParseError('error 3');
      const chunks = state.handleParseError('error 4');

      expect(chunks.length).toBeGreaterThan(0);
      expect(chunks[0]).toContain('network_error');
      expect(chunks[0]).toContain('Unstable network');
    });

    it('should safely close active block on error', () => {
      // Start a text block first
      state.startBlock('Text', { type: 'text', text: '' });

      const chunks = state.handleParseError('error during block');

      // Should contain content_block_stop event
      expect(chunks.some((c) => c.includes('content_block_stop'))).toBe(true);
    });
  });

  describe('resetErrorState', () => {
    it('should reset error counter', () => {
      state.handleParseError('error 1');
      state.handleParseError('error 2');
      state.resetErrorState();

      // After reset, should start counting from 0
      const chunks = state.handleParseError('error after reset');
      expect(chunks).toEqual([]);
    });
  });

  describe('getErrorCount', () => {
    it('should return current error count', () => {
      expect(state.getErrorCount()).toBe(0);
      state.handleParseError('error 1');
      expect(state.getErrorCount()).toBe(1);
      state.handleParseError('error 2');
      expect(state.getErrorCount()).toBe(2);
    });
  });

  describe('stream aggregation compatibility', () => {
    it('always includes zero usage in message_start when upstream usage is absent', () => {
      const output = state.emitMessageStart({ modelVersion: 'gemini-3-flash' });
      const dataLine = output.split('\n').find((line) => line.startsWith('data: '));
      const payload = JSON.parse(dataLine?.slice('data: '.length) ?? '{}') as {
        message: { usage: unknown };
      };

      expect(payload.message.usage).toEqual({ input_tokens: 0, output_tokens: 0 });
    });

    it('maps upstream usage into message_start when it is present', () => {
      const output = state.emitMessageStart({
        modelVersion: 'gemini-3-flash',
        usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 3 },
      });
      const dataLine = output.split('\n').find((line) => line.startsWith('data: '));
      const payload = JSON.parse(dataLine?.slice('data: '.length) ?? '{}') as {
        message: { usage: unknown };
      };

      expect(payload.message.usage).toMatchObject({ input_tokens: 8, output_tokens: 3 });
    });

    it('emits a complete minimal Anthropic response when upstream produces no content', () => {
      const chunks = state.emitFinish();
      const output = chunks.join('');
      const events = output
        .split('\n')
        .filter((line) => line.startsWith('event: '))
        .map((line) => line.slice('event: '.length));

      expect(events).toEqual([
        'message_start',
        'content_block_start',
        'content_block_stop',
        'message_delta',
        'message_stop',
      ]);
      expect(output).toContain('"model":"gemini-auto"');
      expect(output).toContain('"usage":{"input_tokens":0,"output_tokens":0}');
      expect(output).toContain('"content_block":{"type":"text","text":"."}');
      expect(output).not.toContain('"type":"text_delta"');
      expect(output).toContain('"usage":{"input_tokens":1,"output_tokens":1}');
    });

    it('uses end_turn and recovery usage for an empty MAX_TOKENS response', () => {
      const output = state
        .emitFinish('MAX_TOKENS', { promptTokenCount: 50, candidatesTokenCount: 60 })
        .join('');

      expect(output).toContain('"content_block":{"type":"text","text":"."}');
      expect(output).toContain('"stop_reason":"end_turn"');
      expect(output).toContain('"usage":{"input_tokens":1,"output_tokens":1}');
      expect(output).not.toContain('"stop_reason":"max_tokens"');
    });

    it('emits tool_use stop reason when functionCall appears in stream', () => {
      const processor = new PartProcessor(state);
      const functionChunks = processor.process({
        functionCall: {
          name: 'builtin_web_search',
          args: { query: 'gemini docs' },
          id: 'call_stream_1',
        },
      });
      const finishChunks = state.emitFinish('STOP', {
        promptTokenCount: 2,
        candidatesTokenCount: 3,
      } as any);

      const output = [...functionChunks, ...finishChunks].join('');
      expect(output).toContain('"type":"tool_use"');
      expect(output).toContain('"stop_reason":"tool_use"');
      expect(output).toContain('"message_stop"');
      expect(output).not.toContain('"content_block":{"type":"text","text":"."}');
    });

    it('includes cache-read tokens in the final Anthropic usage event', () => {
      new PartProcessor(state).process({ text: 'answer' });
      const chunks = state.emitFinish('STOP', {
        cachedContentTokenCount: 5,
        candidatesTokenCount: 3,
        promptTokenCount: 10,
      });

      expect(chunks.join('')).toContain('"cache_read_input_tokens":5');
    });

    it('preserves Interactions usage fields in the final Anthropic event', () => {
      new PartProcessor(state).process({ text: 'answer' });
      const chunks = state.emitFinish('STOP', {
        total_input_tokens: 100,
        total_output_tokens: 12,
        total_cached_tokens: 40,
        total_thought_tokens: 7,
      });

      expect(chunks.join('')).toContain(
        '"input_tokens":100,"output_tokens":12,"cache_read_input_tokens":40,"reasoning_tokens":7',
      );
    });

    it('aggregates grounding metadata into final text block', () => {
      state.webSearchQuery = 'gemini api';
      state.groundingChunks = [
        {
          web: {
            title: 'Gemini API Docs',
            uri: 'https://example.com/gemini',
          },
        },
      ];

      const chunks = state.emitFinish('STOP', {
        promptTokenCount: 1,
        candidatesTokenCount: 1,
      } as any);
      const output = chunks.join('');

      expect(output).toContain('Searched for you');
      expect(output).toContain('Citations');
      expect(output).toContain('https://example.com/gemini');
      expect(output).not.toContain('"text":"."');
    });
  });
  describe('thought parts that carry nothing', () => {
    it('opens no thinking block for a thought with neither text nor signature', () => {
      const processor = new PartProcessor(state);

      const payload = [
        ...processor.process({ thought: true, text: '' }),
        ...state.emitFinish('STOP'),
      ].join('');

      expect(payload).not.toContain('"content_block":{"type":"thinking"');
      expect(payload).not.toContain('"thinking_delta"');
      expect(payload).toContain('"content_block":{"type":"text","text":"."}');
    });

    it('still opens a thinking block for an empty thought that carries a signature', () => {
      const processor = new PartProcessor(state);
      const signature = Buffer.from('empty-thought-signature').toString('base64');

      const payload = [
        ...processor.process({ thought: true, text: '', thoughtSignature: signature }),
        ...state.emitFinish('STOP'),
      ].join('');

      expect(payload).toContain('"content_block":{"type":"thinking"');
      expect(payload).toContain('"signature_delta"');
      expect(payload).not.toContain('"content_block":{"type":"text","text":"."}');
    });

    it('does not recover with text after flushing a stored trailing signature', () => {
      const processor = new PartProcessor(state);
      const signature = Buffer.from('stored-trailing-signature').toString('base64');

      const payload = [
        ...processor.process({ text: '', thoughtSignature: signature }),
        ...processor.process({ thought: true, text: '' }),
        ...state.emitFinish('STOP'),
      ].join('');

      expect(payload).toContain('"signature_delta"');
      expect(state.hasThinking).toBe(true);
      expect(payload).not.toContain('"content_block":{"type":"text","text":"."}');
    });

    it('keeps the thinking text of a thought that has content', () => {
      const processor = new PartProcessor(state);

      const payload = [
        ...processor.process({ thought: true, text: 'weighing the options' }),
        ...state.emitFinish('STOP'),
      ].join('');

      expect(payload).toContain('"content_block":{"type":"thinking"');
      expect(payload).toContain('"thinking":"weighing the options"');
      expect(payload).not.toContain('"content_block":{"type":"text","text":"."}');
    });
  });
  describe('Anthropic message identity', () => {
    function messageIdOf(streamStart: string): string | undefined {
      const dataLine = streamStart.split('\n').find((line) => line.startsWith('data: '));
      const payload = JSON.parse(dataLine?.slice('data: '.length) ?? '{}') as {
        message?: { id?: string };
      };
      return payload.message?.id;
    }

    it('gives a raw upstream identifier the msg_ prefix an Anthropic client expects', () => {
      expect(messageIdOf(state.emitMessageStart({ responseId: 'wOx3aunrMOLfxs0P' }))).toBe(
        'msg_wOx3aunrMOLfxs0P',
      );
    });

    it('leaves an upstream identifier that already carries the prefix alone', () => {
      expect(messageIdOf(state.emitMessageStart({ responseId: 'msg_existing' }))).toBe(
        'msg_existing',
      );
    });

    it('mints a unique prefixed id instead of one shared constant', () => {
      const first = messageIdOf(state.emitMessageStart({ modelVersion: 'gemini-3-flash' }));
      const second = messageIdOf(
        new StreamingState().emitMessageStart({ modelVersion: 'gemini-3-flash' }),
      );

      expect(first).toMatch(/^msg_[0-9a-f-]{36}$/u);
      expect(first).not.toBe(second);
    });

    it('names the same upstream response the same way streamed and unary', () => {
      const streamed = messageIdOf(state.emitMessageStart({ responseId: 'vux3arD5GLnT28oP' }));
      const unary = transformResponse({ responseId: 'vux3arD5GLnT28oP' });

      expect(streamed).toBe(unary.id);
    });
  });
});
