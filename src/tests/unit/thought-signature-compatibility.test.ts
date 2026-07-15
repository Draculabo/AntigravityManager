import { describe, expect, it } from 'vitest';

import { transformClaudeRequestIn } from '@/modules/proxy-gateway/antigravity/ClaudeRequestMapper';
import { transformResponse } from '@/modules/proxy-gateway/antigravity/ClaudeResponseMapper';
import {
  PartProcessor,
  StreamingState,
} from '@/modules/proxy-gateway/antigravity/ClaudeStreamingMapper';
import type { ClaudeRequest } from '@/modules/proxy-gateway/antigravity/types';

const THOUGHT_SIGNATURE = 'thought-signature-for-tool-call';

describe('thought signature compatibility', () => {
  it('sends both signature field names for thinking, function calls, and tool results', () => {
    const request: ClaudeRequest = {
      model: 'gemini-3-flash',
      max_tokens: 1024,
      thinking: { type: 'enabled', budget_tokens: 256 },
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'I should call the tool.', signature: THOUGHT_SIGNATURE },
            {
              type: 'tool_use',
              id: 'call_weather',
              name: 'get_weather',
              input: { location: 'London' },
            },
          ],
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'call_weather',
              content: 'Cloudy',
            },
          ],
        },
      ],
    };

    const body = transformClaudeRequestIn(request);
    const [thinkingPart, functionCallPart] = body.request.contents[0].parts;
    const [functionResponsePart] = body.request.contents[1].parts;

    for (const part of [thinkingPart, functionCallPart, functionResponsePart]) {
      expect(part.thoughtSignature).toBe(THOUGHT_SIGNATURE);
      expect(part.thought_signature).toBe(THOUGHT_SIGNATURE);
    }
  });

  it('accepts snake-case signatures from non-streaming Gemini responses', () => {
    const response = transformResponse({
      candidates: [
        {
          content: {
            role: 'model',
            parts: [
              {
                functionCall: {
                  name: 'get_weather',
                  args: { location: 'London' },
                  id: 'call_weather',
                },
                thought_signature: THOUGHT_SIGNATURE,
              },
            ],
          },
        },
      ],
    });

    expect(response.content).toContainEqual({
      type: 'tool_use',
      id: 'call_weather',
      name: 'get_weather',
      input: { location: 'London' },
      signature: THOUGHT_SIGNATURE,
    });
  });

  it('accepts snake-case signatures from streaming Gemini responses', () => {
    const state = new StreamingState();
    const processor = new PartProcessor(state);
    const chunks = processor.process({
      text: 'Reasoning',
      thought: true,
      thought_signature: THOUGHT_SIGNATURE,
    });
    chunks.push(...state.emitFinish('STOP', {}));

    expect(chunks.join('')).toContain(THOUGHT_SIGNATURE);
  });
});
