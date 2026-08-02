import { describe, expect, it } from 'vitest';

import { toOpenAIResponsesResponse } from '../../modules/proxy-gateway/antigravity/OpenAIResponsesResponseMapper';

describe('OpenAI Responses non-stream mapper', () => {
  it('emits safety feedback as a Responses refusal content part', () => {
    const response = toOpenAIResponsesResponse({
      id: 'resp_refused',
      object: 'chat.completion',
      created: 1,
      model: 'gpt-5-codex',
      choices: [
        {
          index: 0,
          finish_reason: 'content_filter',
          message: {
            role: 'assistant',
            content: null,
            refusal: 'Request blocked by safety policy (blockReason: SAFETY)',
          },
        },
      ],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 0,
        total_tokens: 10,
      },
    });

    expect(response.output).toEqual([
      {
        content: [
          {
            refusal: 'Request blocked by safety policy (blockReason: SAFETY)',
            type: 'refusal',
          },
        ],
        id: 'msg_resp_refused',
        role: 'assistant',
        status: 'completed',
        type: 'message',
      },
    ]);
  });

  it('repairs apply_patch input in a non-stream Responses tool call', () => {
    const patch = [
      '*** Begin Patch',
      '--- a/src/example.ts',
      '+++ b/src/example.ts',
      '@@ -1 +1 @@',
      '-const value = 1;',
      '+const value = 2;',
      '*** End Patch',
    ].join('\n');
    const response = toOpenAIResponsesResponse({
      id: 'resp_patch',
      object: 'chat.completion',
      created: 1,
      model: 'gpt-5-codex',
      choices: [
        {
          index: 0,
          finish_reason: 'tool_calls',
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_patch',
                type: 'function',
                function: {
                  name: 'apply_patch',
                  arguments: JSON.stringify({ command: ['apply_patch', patch] }),
                },
              },
            ],
          },
        },
      ],
      usage: {
        prompt_tokens: 1,
        completion_tokens: 1,
        total_tokens: 2,
      },
    });

    expect(response.output).toEqual([
      expect.objectContaining({
        input: [
          '*** Begin Patch',
          '*** Update File: src/example.ts',
          '@@',
          '-const value = 1;',
          '+const value = 2;',
          '*** End Patch',
        ].join('\n'),
        name: 'apply_patch',
        type: 'custom_tool_call',
      }),
    ]);
  });

  it('emits a diagnostic instead of an invalid non-stream apply_patch tool call', () => {
    const response = toOpenAIResponsesResponse({
      id: 'resp_patch_invalid',
      object: 'chat.completion',
      created: 1,
      model: 'gpt-5-codex',
      choices: [
        {
          index: 0,
          finish_reason: 'tool_calls',
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_patch_invalid',
                type: 'function',
                function: {
                  name: 'apply_patch',
                  arguments: JSON.stringify({ input: 'this is not a patch' }),
                },
              },
            ],
          },
        },
      ],
      usage: {
        prompt_tokens: 1,
        completion_tokens: 1,
        total_tokens: 2,
      },
    });

    expect(response.output).toEqual([
      expect.objectContaining({
        content: [
          expect.objectContaining({
            text: expect.stringContaining('apply_patch rejected'),
            type: 'output_text',
          }),
        ],
        type: 'message',
      }),
    ]);
  });
});
