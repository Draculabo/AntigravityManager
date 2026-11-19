import { describe, expect, it } from 'vitest';

import { transformClaudeRequestIn } from '@/modules/proxy-gateway/antigravity/ClaudeRequestMapper';
import type { ClaudeRequest, Message } from '@/modules/proxy-gateway/antigravity/types';

const signature = 'opaque-signed-history-value';
const thinking = ' \nOriginal reasoning.\t \n';
const textCases = [
  ['surrounding whitespace', ' \r\nOriginal assistant text.\t \n'],
  ['whitespace-only text', ' \r\n\t '],
  ['literal placeholder text', '(no content)'],
  ['literal inline-image markdown', ' \n![literal](data:image/png;base64,YWJj) \t'],
] as const;

function request(content: Message['content'], role = 'assistant'): ClaudeRequest {
  return {
    model: 'gemini-3-flash',
    thinking: { type: 'disabled' },
    messages: [
      { role: 'user', content: 'Read A.' },
      { role, content },
    ],
  };
}

describe('signed assistant history text', () => {
  for (const source of ['thinking', 'tool'] as const) {
    it.each(textCases)(`preserves %s when the signature belongs to ${source}`, (_label, text) => {
      const history = request([
        { type: 'thinking', thinking, ...(source === 'thinking' ? { signature } : {}) },
        { type: 'text', text },
        {
          type: 'tool_use',
          id: 'call-read',
          name: 'read',
          input: { path: '/a' },
          ...(source === 'tool' ? { signature } : {}),
        },
      ]);
      const before = structuredClone(history);
      const result = transformClaudeRequestIn(history, undefined, undefined, undefined);
      const parts = result.request.contents[1].parts;
      expect(parts.filter((part) => part.text !== undefined && !part.thought)).toEqual([{ text }]);
      expect(parts.find((part) => part.thought)?.text).toBe(thinking);
      expect(history).toEqual(before);
    });
  }

  it.each(['user', 'assistant'])('preserves unsigned %s whitespace', (role) => {
    const result = transformClaudeRequestIn(
      request([{ type: 'text', text: ' \nOrdinary text.\t ' }], role),
      undefined,
      undefined,
      undefined,
    );
    expect(result.request.contents[1].parts).toEqual([{ text: ' \nOrdinary text.\t ' }]);
  });
});
