import { describe, expect, it } from 'vitest';

import {
  detectAuditOutputModalities,
  mergeAuditOutputModalities,
} from '@/modules/proxy-gateway/audit/audit-output-modality';

describe('traffic audit output modality', () => {
  it('classifies only generated Gemini parts, excluding thought and input content', () => {
    expect(
      detectAuditOutputModalities({
        response: {
          candidates: [
            {
              content: {
                parts: [
                  { thought: true, text: 'hidden analysis' },
                  { text: 'visible answer' },
                  { inlineData: { mimeType: 'image/png', data: 'base64-image' } },
                ],
              },
            },
          ],
        },
        request: { parts: [{ text: 'input must not count' }] },
      }),
    ).toEqual({ hasImage: true, hasText: true });
  });

  it('classifies OpenAI and Anthropic output without counting tool arguments or reasoning', () => {
    expect(detectAuditOutputModalities({ choices: [{ message: { content: 'answer' } }] })).toEqual({
      hasImage: false,
      hasText: true,
    });
    expect(detectAuditOutputModalities({ choices: [{ text: 'legacy answer' }] })).toEqual({
      hasImage: false,
      hasText: true,
    });
    expect(
      detectAuditOutputModalities({
        output: [
          { type: 'reasoning', summary: [{ text: 'internal' }] },
          { type: 'image_generation_call', result: 'base64-image' },
        ],
      }),
    ).toEqual({ hasImage: true, hasText: false });
    expect(
      detectAuditOutputModalities({
        content: [
          { type: 'thinking', thinking: 'internal' },
          { type: 'tool_use', input: 'code' },
        ],
      }),
    ).toEqual({ hasImage: false, hasText: false });
    expect(
      detectAuditOutputModalities({ created: 1, data: [{ b64_json: 'image-bytes' }] }),
    ).toEqual({
      hasImage: true,
      hasText: false,
    });
    expect(
      detectAuditOutputModalities({
        choices: [{ message: { content: '\n![Generated Image](data:image/png;base64,abc)\n' } }],
      }),
    ).toEqual({ hasImage: true, hasText: false });
    expect(
      detectAuditOutputModalities({
        content: [{ type: 'text', text: 'caption ![image](data:image/png;base64,abc)' }],
      }),
    ).toEqual({ hasImage: true, hasText: true });
  });

  it('unions parsed SSE output while leaving malformed or unsupported content unknown', () => {
    const text = detectAuditOutputModalities({
      type: 'response.output_text.delta',
      delta: 'hello',
    });
    const image = detectAuditOutputModalities({
      type: 'content_block_start',
      content_block: { type: 'image', source: { media_type: 'image/png' } },
    });
    expect(
      detectAuditOutputModalities({
        type: 'response.output_text.delta',
        delta: '![Generated Image](data:image/png;base64,abc)',
      }),
    ).toEqual({ hasImage: true, hasText: false });
    expect(mergeAuditOutputModalities(text, image)).toEqual({ hasImage: true, hasText: true });
    expect(detectAuditOutputModalities('data: malformed')).toBeNull();
    expect(detectAuditOutputModalities({ arbitrary: { text: 'not protocol output' } })).toBeNull();
  });
});
