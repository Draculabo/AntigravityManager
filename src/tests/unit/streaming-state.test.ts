import { describe, it, expect, beforeEach } from 'vitest';
import {
  PartProcessor,
  StreamingState,
} from '../../modules/proxy-gateway/antigravity/ClaudeStreamingMapper';

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
    });

    it('includes cache-read tokens in the final Anthropic usage event', () => {
      const chunks = state.emitFinish('STOP', {
        cachedContentTokenCount: 5,
        candidatesTokenCount: 3,
        promptTokenCount: 10,
      });

      expect(chunks.join('')).toContain('"cache_read_input_tokens":5');
    });

    it('preserves Interactions usage fields in the final Anthropic event', () => {
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
    });

    it('keeps the thinking text of a thought that has content', () => {
      const processor = new PartProcessor(state);

      const payload = [
        ...processor.process({ thought: true, text: 'weighing the options' }),
        ...state.emitFinish('STOP'),
      ].join('');

      expect(payload).toContain('"content_block":{"type":"thinking"');
      expect(payload).toContain('"thinking":"weighing the options"');
    });
  });
});
