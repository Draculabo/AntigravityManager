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
        phase: 'final_answer',
        role: 'assistant',
        status: 'completed',
        type: 'message',
      },
    ]);
    expect(response.error).toBeNull();
  });

  it('preserves reasoning, visible text, refusal, and tool calls as separate output channels', () => {
    const response = toOpenAIResponsesResponse({
      id: 'resp_mixed',
      object: 'chat.completion',
      created: 1,
      model: 'gpt-5-codex',
      choices: [
        {
          index: 0,
          finish_reason: 'tool_calls',
          message: {
            role: 'assistant',
            reasoning_content: 'Inspect the repository first.',
            content: 'I will inspect the repository.',
            refusal: 'One unsafe sub-operation was refused.',
            tool_calls: [
              {
                id: 'call_read',
                type: 'function',
                function: {
                  name: 'read_file',
                  arguments: '{"path":"README.md"}',
                },
              },
            ],
          },
        },
      ],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15,
      },
    });

    expect(response).toMatchObject({ error: null, status: 'completed' });
    expect(response.output).toEqual([
      {
        content: [
          {
            annotations: [],
            text: 'Inspect the repository first.',
            type: 'output_text',
          },
        ],
        id: 'msg_thought_resp_mixed',
        phase: 'commentary',
        role: 'assistant',
        status: 'completed',
        type: 'message',
      },
      {
        content: [
          {
            annotations: [],
            text: 'I will inspect the repository.',
            type: 'output_text',
          },
          {
            refusal: 'One unsafe sub-operation was refused.',
            type: 'refusal',
          },
        ],
        id: 'msg_resp_mixed',
        phase: 'commentary',
        role: 'assistant',
        status: 'completed',
        type: 'message',
      },
      {
        arguments: '{"path":"README.md"}',
        call_id: 'call_read',
        id: 'call_read',
        name: 'read_file',
        status: 'completed',
        type: 'function_call',
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
  it('reports a truncated answer as incomplete instead of completed', () => {
    const response = toOpenAIResponsesResponse({
      id: 'resp_truncated',
      object: 'chat.completion',
      created: 1,
      model: 'gpt-5-codex',
      choices: [
        {
          index: 0,
          finish_reason: 'length',
          message: {
            role: 'assistant',
            content: 'the answer starts and then run',
          },
        },
      ],
      usage: {
        prompt_tokens: 1,
        completion_tokens: 1,
        total_tokens: 2,
      },
    });

    expect(response).toMatchObject({
      incomplete_details: { reason: 'max_output_tokens' },
      status: 'incomplete',
    });
    expect(response.output).toEqual([
      expect.objectContaining({ status: 'incomplete', type: 'message' }),
    ]);
  });

  it('keeps a naturally finished answer completed with no incomplete details', () => {
    const response = toOpenAIResponsesResponse({
      id: 'resp_done',
      object: 'chat.completion',
      created: 1,
      model: 'gpt-5-codex',
      choices: [
        {
          index: 0,
          finish_reason: 'stop',
          message: {
            role: 'assistant',
            content: 'the whole answer',
          },
        },
      ],
      usage: {
        prompt_tokens: 1,
        completion_tokens: 1,
        total_tokens: 2,
      },
    });

    expect(response).toMatchObject({ incomplete_details: null, status: 'completed' });
    expect(response.output).toEqual([
      expect.objectContaining({ status: 'completed', type: 'message' }),
    ]);
  });
});
