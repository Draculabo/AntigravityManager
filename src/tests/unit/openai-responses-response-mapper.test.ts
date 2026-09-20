import { describe, expect, it } from 'vitest';

import { MISSING_COMMAND_FALLBACK } from '@/modules/proxy-gateway/antigravity/CommandToolAdapter';
import { MALFORMED_FUNCTION_CALL_RECOVERY_TEXT } from '@/modules/proxy-gateway/antigravity/GeminiFinishReason';
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
        summary: [{ text: 'Inspect the repository first.', type: 'summary_text' }],
        id: 'reasoning_resp_mixed',
        status: 'completed',
        type: 'reasoning',
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
    expect(Reflect.get(response, 'output')).toEqual([
      expect.objectContaining({ status: 'completed', type: 'message' }),
    ]);
  });

  it('normalizes an incomplete shell tool call in a non-stream Responses response', () => {
    const response = toOpenAIResponsesResponse({
      id: 'resp_missing_command',
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
                id: 'call_terminal',
                type: 'function',
                function: {
                  name: 'terminal',
                  arguments: JSON.stringify({ description: 'sensitive tool detail' }),
                },
              },
            ],
          },
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });

    const output = Reflect.get(response, 'output');
    expect(Array.isArray(output)).toBe(true);
    if (!Array.isArray(output)) {
      throw new Error('Responses mapper did not return an output array');
    }
    const toolCall = output[0];
    if (typeof toolCall !== 'object' || toolCall === null) {
      throw new Error('Responses mapper did not return a function-call object');
    }
    const argumentsValue = Reflect.get(toolCall, 'arguments');
    expect(Reflect.get(toolCall, 'name')).toBe('terminal');
    expect(Reflect.get(toolCall, 'type')).toBe('function_call');
    expect(typeof argumentsValue).toBe('string');
    if (typeof argumentsValue !== 'string') {
      throw new Error('Responses mapper did not serialize function-call arguments');
    }
    expect(JSON.parse(argumentsValue)).toEqual({
      command: MISSING_COMMAND_FALLBACK,
      description: 'sensitive tool detail',
    });
  });

  it('recovers a malformed function call with completed, non-empty Responses output', () => {
    const response = toOpenAIResponsesResponse({
      id: 'resp_malformed_function_call',
      object: 'chat.completion',
      created: 1,
      model: 'gpt-5-codex',
      choices: [
        {
          index: 0,
          finish_reason: 'MALFORMED_FUNCTION_CALL',
          message: { role: 'assistant', content: null },
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 0, total_tokens: 1 },
    });

    expect(response).toMatchObject({ incomplete_details: null, status: 'completed' });
    expect(response.output).toEqual([
      expect.objectContaining({
        content: [
          {
            annotations: [],
            text: MALFORMED_FUNCTION_CALL_RECOVERY_TEXT,
            type: 'output_text',
          },
        ],
        type: 'message',
      }),
    ]);
  });
});
