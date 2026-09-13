import { describe, expect, it } from 'vitest';

import { transformResponse } from '@/modules/proxy-gateway/antigravity/ClaudeResponseMapper';
import {
  PartProcessor,
  StreamingState,
} from '@/modules/proxy-gateway/antigravity/ClaudeStreamingMapper';
import type { GeminiPart } from '@/modules/proxy-gateway/antigravity/types';

function unaryText(text: string, registeredToolNames: readonly string[] = ['Read']) {
  return transformResponse(
    {
      candidates: [{ content: { parts: [{ text }], role: 'model' }, finishReason: 'STOP' }],
    },
    { registeredToolNames },
  );
}

function streamParts(parts: GeminiPart[]) {
  const state = new StreamingState();
  state.setRegisteredToolNames(['Read']);
  const processor = new PartProcessor(state);
  const output = [
    ...parts.flatMap((part) => processor.process(part)),
    ...state.emitFinish('STOP'),
  ].join('');
  return { output, state };
}

describe('Anthropic call:default_api leakage recovery', () => {
  describe('non-streaming', () => {
    it('recovers a registered tool with strict JSON and canonicalizes its name', () => {
      const response = unaryText('  call:default_api:read{"file_path":"C:/tmp/a.txt"}  ');

      expect(response.content).toEqual([
        expect.objectContaining({
          type: 'tool_use',
          name: 'Read',
          input: { file_path: 'C:/tmp/a.txt' },
        }),
      ]);
      expect(response.stop_reason).toBe('tool_use');
    });

    it('recovers a registered no-argument tool as an empty object', () => {
      expect(unaryText('call:default_api:Read').content).toEqual([
        expect.objectContaining({ type: 'tool_use', name: 'Read', input: {} }),
      ]);
    });

    it.each([
      ['no registered tools', 'call:default_api:Read{"file_path":"a"}', []],
      ['an unregistered tool', 'call:default_api:Write{"file_path":"a"}', ['Read']],
      ['surrounding prose', 'Use call:default_api:Read{"file_path":"a"}', ['Read']],
      ['malformed arguments', 'call:default_api:Read{file_path:"a"}', ['Read']],
      ['non-object arguments', 'call:default_api:Read["a"]', ['Read']],
    ])('preserves leakage text for %s', (_case, text, tools) => {
      expect(unaryText(text, tools).content).toEqual([{ type: 'text', text }]);
    });

    it('does not apply the streaming loose-key parser to unary responses', () => {
      const text = 'call:default_api:Read{file_path:"a"}';

      expect(unaryText(text).content).toEqual([{ type: 'text', text }]);
    });

    it('leaves native function calls unchanged', () => {
      const response = transformResponse(
        {
          candidates: [
            {
              content: {
                role: 'model',
                parts: [{ functionCall: { id: 'call_native', name: 'Read', args: { path: 'a' } } }],
              },
            },
          ],
        },
        { registeredToolNames: ['Read'] },
      );

      expect(response.content).toEqual([
        { type: 'tool_use', id: 'call_native', name: 'Read', input: { path: 'a' } },
      ]);
    });
  });

  describe('streaming', () => {
    it.each([
      ['strict JSON', 'call:default_api:read{"file_path":"a"}', '{"file_path":"a"}'],
      ['no arguments', 'call:default_api:Read', '{}'],
      ['bare object keys', 'call:default_api:Read{file_path:"a"}', '{"file_path":"a"}'],
    ])('recovers %s through the native function-call event path', (_case, text, json) => {
      const { output } = streamParts([{ text }]);

      expect(output).toContain('"type":"tool_use"');
      expect(output).toContain('"name":"Read"');
      expect(output).toContain(`"partial_json":"${json.replaceAll('"', '\\"')}"`);
      expect(output).toContain('"stop_reason":"tool_use"');
      expect(output).not.toContain(`"type":"text_delta","text":"${text}`);
    });

    it.each([
      ['an unregistered tool', 'call:default_api:Write{"file_path":"a"}'],
      ['surrounding prose', 'Use call:default_api:Read{"file_path":"a"}'],
      ['malformed arguments', 'call:default_api:Read{file_path:NOT JSON}'],
      ['non-object arguments', 'call:default_api:Read["a"]'],
    ])('fails closed to ordinary text for %s', (_case, text) => {
      const { output } = streamParts([{ text }]);

      expect(output).toContain('"type":"text_delta"');
      expect(output).toContain(JSON.stringify(text).slice(1, -1));
      expect(output).not.toContain('"type":"tool_use"');
    });

    it('fails closed when no tools were registered', () => {
      const state = new StreamingState();
      const output = new PartProcessor(state)
        .process({ text: 'call:default_api:Read{"file_path":"a"}' })
        .join('');

      expect(output).toContain('"type":"text_delta"');
      expect(output).not.toContain('"type":"tool_use"');
    });

    it('does not recover after a native function call', () => {
      const { output } = streamParts([
        { functionCall: { name: 'Read', args: { file_path: 'native' } } },
        { text: 'call:default_api:Read{"file_path":"leaked"}' },
      ]);

      expect(output.match(/"type":"tool_use"/gu)).toHaveLength(1);
      expect(output).toContain('call:default_api:Read');
    });

    it('does not recover after an ordinary text delta', () => {
      const { output } = streamParts([
        { text: 'First, some prose.' },
        { text: 'call:default_api:Read{"file_path":"leaked"}' },
      ]);

      expect(output).not.toContain('"type":"tool_use"');
      expect(output.match(/"type":"text_delta"/gu)).toHaveLength(2);
    });
  });
});
