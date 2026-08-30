import { afterEach, describe, expect, it, vi } from 'vitest';
import { of } from 'rxjs';

import { AnthropicController } from '../../modules/proxy-gateway/server/modules/anthropic/anthropic.controller';
import { OpenAIOperations as ProxyController } from '../../modules/proxy-gateway/server/modules/openai/openai-operations.service';
import { OpenAIResponsesSessionStore } from '../../modules/proxy-gateway/server/modules/openai/responses/openai-responses-session.store';
import { UpstreamRequestError } from '../../modules/proxy-gateway/server/common/exceptions/upstream-request.exception';
import { DEFAULT_APP_CONFIG } from '../../modules/config/types';
import { setServerConfig } from '../../server/server-config';

function createReplyMock() {
  const reply: Record<string, any> = {};
  reply.status = vi.fn(() => reply);
  reply.header = vi.fn(() => reply);
  reply.send = vi.fn(() => reply);
  return reply;
}

function createMultipartRequest(
  parts: Array<
    | { fieldname: string; type: 'field'; value: string }
    | {
        data: Buffer;
        fieldname: string;
        filename: string;
        mimetype: string;
        type: 'file';
      }
  >,
) {
  return {
    headers: {
      'content-type': 'multipart/form-data; boundary=----parity',
    },
    isMultipart: () => true,
    async *parts() {
      for (const part of parts) {
        if (part.type === 'field') {
          yield {
            ...part,
            encoding: '7bit',
            fields: {},
            fieldnameTruncated: false,
            mimetype: 'text/plain',
            valueTruncated: false,
          };
        } else {
          yield {
            ...part,
            encoding: '7bit',
            fields: {},
            toBuffer: async () => part.data,
          };
        }
      }
    },
  };
}

describe('ProxyController Integration', () => {
  afterEach(() => {
    OpenAIResponsesSessionStore.clear();
  });

  it('preserves Responses tool choice and sampling compatibility fields', () => {
    const proxyService = {
      handleChatCompletions: vi.fn(),
      handleAnthropicMessages: vi.fn(),
    };
    const controller = new ProxyController(proxyService as any);

    const prepared = controller.prepareResponsesRequest({
      model: 'gpt-5-codex',
      input: 'update the file',
      tool_choice: { type: 'function', function: { name: 'apply_patch' } },
      presence_penalty: 0.25,
      frequency_penalty: 0.5,
      seed: 42,
    });

    expect(prepared?.request).toMatchObject({
      tool_choice: { type: 'function', function: { name: 'apply_patch' } },
      presence_penalty: 0.25,
      frequency_penalty: 0.5,
      seed: 42,
    });
  });

  it('drops incomplete custom calls and their matching outputs from Responses history', () => {
    const controller = new ProxyController({
      handleChatCompletions: vi.fn(),
      handleAnthropicMessages: vi.fn(),
    } as any);

    const prepared = controller.prepareResponsesRequest({
      model: 'gpt-5-codex',
      input: [
        {
          type: 'custom_tool_call',
          call_id: 'call_incomplete',
          name: 'apply_patch',
          input: '*** Begin Patch\n*** End Patch',
          status: 'incomplete',
        },
        {
          type: 'custom_tool_call_output',
          call_id: 'call_incomplete',
          output: 'failed',
        },
        {
          type: 'message',
          role: 'user',
          content: 'Continue without the incomplete call.',
        },
      ],
    });

    expect(prepared?.request.messages).toEqual([
      {
        role: 'user',
        content: 'Continue without the incomplete call.',
      },
    ]);
  });

  it('drops orphan custom tool outputs from Responses history', () => {
    const controller = new ProxyController({
      handleChatCompletions: vi.fn(),
      handleAnthropicMessages: vi.fn(),
    } as any);

    const prepared = controller.prepareResponsesRequest({
      model: 'gpt-5-codex',
      input: [
        {
          type: 'custom_tool_call_output',
          call_id: 'call_missing',
          output: 'No matching call exists.',
        },
        {
          type: 'message',
          role: 'user',
          content: 'Continue without the orphan output.',
        },
      ],
    });

    expect(prepared?.request.messages).toEqual([
      {
        role: 'user',
        content: 'Continue without the orphan output.',
      },
    ]);
  });

  it('accepts a Responses message item that omits type when role is present', () => {
    const controller = new ProxyController({
      handleChatCompletions: vi.fn(),
      handleAnthropicMessages: vi.fn(),
    } as any);

    const prepared = controller.prepareResponsesRequest({
      model: 'gpt-5-codex',
      input: [
        {
          role: 'user',
          content: 'Keep this role-bearing message.',
        },
        {
          type: 123,
          role: 'assistant',
          content: 'Treat a non-string type as absent.',
        },
      ],
    });

    expect(prepared?.request.messages).toEqual([
      {
        role: 'user',
        content: 'Keep this role-bearing message.',
      },
      {
        role: 'user',
        content: 'Treat a non-string type as absent.',
      },
    ]);
  });

  it('rewrites only a terminal assistant text prefill as a user message', () => {
    const controller = new ProxyController({
      handleChatCompletions: vi.fn(),
      handleAnthropicMessages: vi.fn(),
    } as any);

    const prepared = controller.prepareResponsesRequest({
      model: 'gpt-5-codex',
      input: [
        {
          type: 'message',
          role: 'user',
          content: 'Complete this prefix.',
        },
        {
          type: 'message',
          role: 'assistant',
          content: 'The answer begins',
        },
      ],
    });

    expect(prepared?.request.messages).toEqual([
      {
        role: 'user',
        content: 'Complete this prefix.',
      },
      {
        role: 'user',
        content: 'The answer begins',
      },
    ]);
  });

  it('drops leading orphan tool history after the system prefix', () => {
    const controller = new ProxyController({
      handleChatCompletions: vi.fn(),
      handleAnthropicMessages: vi.fn(),
    } as any);

    const prepared = controller.prepareResponsesRequest({
      model: 'gpt-5-codex',
      instructions: 'Follow the project instructions.',
      input: [
        {
          type: 'function_call',
          call_id: 'call_orphan',
          name: 'read_file',
          arguments: '{}',
        },
        {
          type: 'function_call_output',
          call_id: 'call_orphan',
          output: 'stale output',
        },
        {
          type: 'message',
          role: 'user',
          content: 'Start from this request.',
        },
      ],
    });

    expect(prepared?.request.messages).toEqual([
      {
        role: 'system',
        content: 'Follow the project instructions.',
      },
      {
        role: 'user',
        content: 'Start from this request.',
      },
    ]);
  });

  it('compacts repeated apply_patch failures in Responses history', () => {
    const controller = new ProxyController({
      handleChatCompletions: vi.fn(),
      handleAnthropicMessages: vi.fn(),
    } as any);
    const failure = [
      'apply_patch verification failed',
      'Failed to find expected lines in src/example.ts:',
      'const value = 1;',
    ].join('\n');

    const prepared = controller.prepareResponsesRequest({
      model: 'gpt-5-codex',
      input: [
        {
          type: 'message',
          role: 'user',
          content: 'Apply these changes.',
        },
        {
          type: 'custom_tool_call',
          call_id: 'call_failure_1',
          name: 'apply_patch',
          input: '*** Begin Patch\n*** End Patch',
        },
        {
          type: 'custom_tool_call_output',
          call_id: 'call_failure_1',
          output: failure,
        },
        {
          type: 'custom_tool_call',
          call_id: 'call_failure_2',
          name: 'apply_patch',
          input: '*** Begin Patch\n*** End Patch',
        },
        {
          type: 'custom_tool_call_output',
          call_id: 'call_failure_2',
          output: failure,
        },
      ],
    });

    const toolMessages = prepared?.request.messages.filter((message) => message.role === 'tool');
    expect(toolMessages).toEqual([
      expect.objectContaining({ content: failure }),
      expect.objectContaining({
        content:
          '[Repeated apply_patch failure omitted: the same error was already provided earlier in this request.]',
      }),
    ]);
  });

  it('lists Antigravity public presets alongside discovered chat models', () => {
    const proxyService = {
      handleChatCompletions: vi.fn(),
      handleAnthropicMessages: vi.fn(),
    };
    const accountLeaseService = {
      getAllCollectedModels: vi.fn(
        () =>
          new Set([
            'gemini-3.5-flash-low',
            'gemini-3-flash',
            'gemini-3-pro-image',
            'gemini-imagecraft-chat',
          ]),
      ),
    };
    const controller = new ProxyController(proxyService as any, accountLeaseService as any);
    const reply = createReplyMock();

    controller.listModels(reply as any);

    expect(reply.status).toHaveBeenCalledWith(200);
    const payload = reply.send.mock.calls[0][0];
    const ids = payload.data.map((model: { id: string }) => model.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        'gemini-3.5-flash-medium',
        'gemini-3.5-flash-high',
        'gemini-3.5-flash-low',
        'gemini-3.1-pro-low',
        'gemini-3.1-pro-high',
        'claude-sonnet-4-6-thinking',
        'claude-opus-4-6-thinking',
        'gpt-oss-120b-medium',
      ]),
    );
    expect(ids).not.toContain('gemini-3-pro-image');
    expect(ids).toContain('gemini-imagecraft-chat');
  });

  it('lists the exact raw quota models, including physical image models', () => {
    setServerConfig({
      ...DEFAULT_APP_CONFIG.proxy,
      only_raw_quota_models: true,
      custom_mapping: {
        'gpt-4o': 'gemini-3-flash',
      },
    });

    const accountLeaseService = {
      getAllRawQuotaModels: vi.fn(
        () => new Set(['gemini-3-pro-image', 'gemini-2.5-flash', 'gemini-pro-agent']),
      ),
    };
    const controller = new ProxyController({} as any, accountLeaseService as any);
    const reply = createReplyMock();

    controller.listModels(reply as any);
    setServerConfig(DEFAULT_APP_CONFIG.proxy);

    expect(reply.status).toHaveBeenCalledWith(200);
    expect(accountLeaseService.getAllRawQuotaModels).toHaveBeenCalledOnce();
    expect(reply.send).toHaveBeenCalledWith({
      object: 'list',
      data: [
        {
          id: 'gemini-2.5-flash',
          object: 'model',
          created: 1770652800,
          owned_by: 'antigravity',
        },
        {
          id: 'gemini-3-pro-image',
          object: 'model',
          created: 1770652800,
          owned_by: 'antigravity',
        },
        {
          id: 'gemini-pro-agent',
          object: 'model',
          created: 1770652800,
          owned_by: 'antigravity',
        },
      ],
    });
  });

  it('routes Claude OpenAI requests to protocol parity path', async () => {
    const proxyService = {
      handleChatCompletions: vi.fn().mockResolvedValue({ ok: true }),
      handleAnthropicMessages: vi.fn(),
    };
    const controller = new ProxyController(proxyService as any);
    const reply = createReplyMock();

    await controller.chatCompletions(
      {
        model: 'claude-sonnet-4-5',
        stream: false,
        messages: [{ role: 'user', content: 'hello' }],
      } as any,
      reply as any,
    );

    expect(proxyService.handleChatCompletions).toHaveBeenCalledOnce();
    expect(proxyService.handleAnthropicMessages).not.toHaveBeenCalled();
    expect(reply.status).toHaveBeenCalledWith(200);
  });

  it('returns stream response with SSE headers for parity stream path', async () => {
    const stream = of('data: {"ok":true}\n\n');
    const proxyService = {
      handleChatCompletions: vi.fn().mockResolvedValue(stream),
      handleAnthropicMessages: vi.fn(),
    };
    const controller = new ProxyController(proxyService as any);
    const reply = createReplyMock();

    await controller.chatCompletions(
      {
        model: 'claude-sonnet-4-5',
        stream: true,
        messages: [{ role: 'user', content: 'hello' }],
      } as any,
      reply as any,
    );

    expect(reply.header).toHaveBeenCalledWith('Content-Type', 'text/event-stream');
    expect(reply.header).toHaveBeenCalledWith('Cache-Control', 'no-cache');
    expect(reply.header).toHaveBeenCalledWith('Connection', 'keep-alive');
    expect(reply.send).toHaveBeenCalledWith(stream);
  });

  it('supports OpenAI completions compatibility endpoint', async () => {
    const proxyService = {
      handleChatCompletions: vi.fn().mockResolvedValue({
        id: 'chatcmpl_test',
        object: 'chat.completion',
        created: 1700000000,
        model: 'gpt-4o',
        choices: [
          {
            index: 0,
            finish_reason: 'stop',
            message: {
              role: 'assistant',
              content: 'hello from assistant',
            },
          },
        ],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 5,
          total_tokens: 15,
        },
      }),
      handleAnthropicMessages: vi.fn(),
    };
    const controller = new ProxyController(proxyService as any);
    const reply = createReplyMock();

    await controller.completions(
      {
        model: 'gpt-4o',
        prompt: 'hello world',
        stream: false,
      },
      reply as any,
    );

    expect(proxyService.handleChatCompletions).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'hello world' }],
      }),
    );
    expect(reply.status).toHaveBeenCalledWith(200);
    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({
        object: 'text_completion',
        model: 'gpt-4o',
        choices: [
          expect.objectContaining({
            text: 'hello from assistant',
            logprobs: null,
          }),
        ],
      }),
    );
  });

  it('supports OpenAI responses compatibility endpoint with normalized input', async () => {
    const proxyService = {
      handleChatCompletions: vi.fn().mockResolvedValue({
        id: 'chatcmpl_resp',
        object: 'chat.completion',
        created: 1700000001,
        model: 'gpt-4o',
        choices: [
          {
            index: 0,
            finish_reason: 'stop',
            message: {
              content: 'normalized response',
            },
          },
        ],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 6,
          total_tokens: 16,
        },
      }),
    };

    const controller = new ProxyController(proxyService as any);
    const reply = createReplyMock();

    await controller.responses(
      {
        model: 'gpt-4o',
        instructions: 'Follow the tool protocol',
        metadata: { session_id: 'responses-session-1' },
        input: [
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'hello' }],
          },
          {
            type: 'function_call',
            id: 'call_1',
            name: 'search_docs',
            arguments: '{"query":"token"}',
          },
          {
            type: 'function_call_output',
            call_id: 'call_1',
            output: { content: 'result: ok' },
          },
        ],
      },
      reply as any,
    );

    const callArg = proxyService.handleChatCompletions.mock.calls[0][0];
    expect(callArg.messages[0]).toEqual({
      role: 'system',
      content: 'Follow the tool protocol',
    });
    expect(callArg.extra).toMatchObject({ session_id: 'responses-session-1' });
    expect(callArg.messages.some((message: { role: string }) => message.role === 'assistant')).toBe(
      true,
    );
    expect(callArg.messages.some((message: { role: string }) => message.role === 'tool')).toBe(
      true,
    );
    expect(reply.status).toHaveBeenCalledWith(200);
    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({
        object: 'response',
        model: 'gpt-4o',
        output: [
          expect.objectContaining({
            content: [
              expect.objectContaining({
                text: 'normalized response',
                type: 'output_text',
              }),
            ],
            type: 'message',
          }),
        ],
        status: 'completed',
        type: 'response',
        usage: expect.objectContaining({
          input_tokens: 10,
          output_tokens: 6,
          total_tokens: 16,
        }),
      }),
    );
  });

  it('supports OpenAI responses compatibility endpoint in stream mode with SSE headers', async () => {
    const stream = of('data: {"id":"chatcmpl_resp_stream"}\n\n');
    const proxyService = {
      handleChatCompletions: vi.fn().mockResolvedValue(stream),
    };

    const controller = new ProxyController(proxyService as any);
    const reply = createReplyMock();

    await controller.responses(
      {
        model: 'gpt-4o',
        instructions: 'stream output',
        input: 'hello',
        stream: true,
      },
      reply as any,
    );

    expect(reply.header).toHaveBeenCalledWith('Content-Type', 'text/event-stream');
    expect(reply.header).toHaveBeenCalledWith('Cache-Control', 'no-cache');
    expect(reply.header).toHaveBeenCalledWith('Connection', 'keep-alive');
    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({ subscribe: expect.any(Function) }),
    );
    expect(proxyService.handleChatCompletions).toHaveBeenCalledWith(
      expect.any(Object),
      'responses',
    );
  });

  it('normalizes web_search_call in /v1/responses into builtin_web_search tool messages', async () => {
    const proxyService = {
      handleChatCompletions: vi.fn().mockResolvedValue({
        id: 'chatcmpl_resp_search',
        object: 'chat.completion',
        created: 1700000002,
        model: 'gpt-4o',
        choices: [{ index: 0, finish_reason: 'stop', message: { content: 'done' } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    };

    const controller = new ProxyController(proxyService as any);
    const reply = createReplyMock();

    await controller.responses(
      {
        model: 'gpt-4o',
        input: [
          {
            type: 'message',
            role: 'user',
            content: 'Search for the Gemini API.',
          },
          {
            type: 'web_search_call',
            call_id: 'call_search_1',
            action: { query: 'gemini api' },
          },
          {
            type: 'function_call_output',
            call_id: 'call_search_1',
            output: { content: 'search result' },
          },
        ],
      },
      reply as any,
    );

    const callArg = proxyService.handleChatCompletions.mock.calls[0][0];
    const assistantMessage = callArg.messages.find(
      (message: { role: string }) => message.role === 'assistant',
    );
    const toolMessage = callArg.messages.find(
      (message: { role: string }) => message.role === 'tool',
    );

    expect(assistantMessage?.tool_calls?.[0]?.function?.name).toBe('builtin_web_search');
    expect(toolMessage?.name).toBe('builtin_web_search');
  });

  it('preserves apply_patch custom tool calls in /v1/responses', async () => {
    const patch = '*** Begin Patch\n*** Update File: src/example.ts\n*** End Patch';
    const proxyService = {
      handleChatCompletions: vi.fn().mockResolvedValue({
        id: 'chatcmpl_resp_patch',
        object: 'chat.completion',
        created: 1700000003,
        model: 'gpt-4o',
        choices: [
          {
            index: 0,
            finish_reason: 'tool_calls',
            message: {
              content: '',
              tool_calls: [
                {
                  id: 'call_patch_2',
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
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    };
    const controller = new ProxyController(proxyService as any);
    const reply = createReplyMock();

    await controller.responses(
      {
        model: 'gpt-4o',
        input: [
          {
            type: 'message',
            role: 'user',
            content: 'Apply this patch.',
          },
          {
            type: 'custom_tool_call',
            call_id: 'call_patch_1',
            name: 'apply_patch',
            input: patch,
          },
          {
            type: 'custom_tool_call_output',
            call_id: 'call_patch_1',
            output: 'Done',
          },
        ],
      },
      reply as any,
    );

    const callArg = proxyService.handleChatCompletions.mock.calls[0][0];
    const assistantMessage = callArg.messages.find(
      (message: { role: string }) => message.role === 'assistant',
    );
    const toolMessage = callArg.messages.find(
      (message: { role: string }) => message.role === 'tool',
    );

    expect(assistantMessage?.tool_calls?.[0]).toMatchObject({
      custom_input: patch,
      function: { name: 'apply_patch' },
    });
    expect(toolMessage).toMatchObject({
      content: 'Done',
      name: 'apply_patch',
      tool_call_id: 'call_patch_1',
    });
    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({
        output: [
          expect.objectContaining({
            call_id: 'call_patch_2',
            input: patch,
            name: 'apply_patch',
            type: 'custom_tool_call',
          }),
        ],
      }),
    );
  });

  it('continues a Responses conversation from previous_response_id', async () => {
    const proxyService = {
      handleChatCompletions: vi
        .fn()
        .mockResolvedValueOnce({
          id: 'resp_previous_1',
          object: 'chat.completion',
          created: 1700000004,
          model: 'gpt-4o',
          choices: [
            {
              index: 0,
              finish_reason: 'stop',
              message: { content: 'First answer' },
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        })
        .mockResolvedValueOnce({
          id: 'resp_previous_2',
          object: 'chat.completion',
          created: 1700000005,
          model: 'gpt-4o',
          choices: [
            {
              index: 0,
              finish_reason: 'stop',
              message: { content: 'Second answer' },
            },
          ],
          usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
        }),
    };
    const controller = new ProxyController(proxyService as any);

    await controller.responses(
      { input: 'First question', model: 'gpt-4o' },
      createReplyMock() as any,
    );
    await controller.responses(
      { input: 'Second question', previous_response_id: 'resp_previous_1' },
      createReplyMock() as any,
    );

    const continuationRequest = proxyService.handleChatCompletions.mock.calls[1][0];
    expect(continuationRequest).toMatchObject({ model: 'gpt-4o' });
    expect(continuationRequest.messages).toEqual([
      { role: 'user', content: 'First question' },
      { role: 'assistant', content: 'First answer' },
      { role: 'user', content: 'Second question' },
    ]);
  });

  it('drops repaired tool-only history when a compacted continuation has no ordinary message', async () => {
    const patch = '*** Begin Patch\n*** Add File: src/new.ts\n+export {};\n*** End Patch';
    const proxyService = {
      handleChatCompletions: vi
        .fn()
        .mockResolvedValueOnce({
          id: 'resp_compaction_1',
          object: 'chat.completion',
          created: 1700000006,
          model: 'gpt-4o',
          choices: [
            {
              index: 0,
              finish_reason: 'tool_calls',
              message: {
                content: '',
                tool_calls: [
                  {
                    id: 'call_patch_compacted',
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
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        })
        .mockResolvedValueOnce({
          id: 'resp_compaction_2',
          object: 'chat.completion',
          created: 1700000007,
          model: 'gpt-4o',
          choices: [
            {
              index: 0,
              finish_reason: 'stop',
              message: { content: 'Applied' },
            },
          ],
          usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
        }),
    };
    const controller = new ProxyController(proxyService as any);

    await controller.responses(
      { input: 'Create the file', model: 'gpt-4o' },
      createReplyMock() as any,
    );
    await controller.responses(
      {
        previous_response_id: 'resp_compaction_1',
        input: [
          { type: 'compaction_summary', content: 'Earlier context was compacted.' },
          {
            type: 'custom_tool_call_output',
            call_id: 'call_patch_compacted',
            output: 'Done',
          },
        ],
      },
      createReplyMock() as any,
    );

    const continuationRequest = proxyService.handleChatCompletions.mock.calls[1][0];
    expect(continuationRequest.messages).toEqual([{ role: 'user', content: '' }]);
  });

  it('rejects an unknown previous_response_id', async () => {
    const proxyService = { handleChatCompletions: vi.fn() };
    const controller = new ProxyController(proxyService as any);
    const reply = createReplyMock();

    await controller.responses(
      { input: 'Continue', previous_response_id: 'resp_missing' },
      reply as any,
    );

    expect(proxyService.handleChatCompletions).not.toHaveBeenCalled();
    expect(reply.status).toHaveBeenCalledWith(404);
    expect(reply.send).toHaveBeenCalledWith({
      error: {
        code: 'previous_response_not_found',
        message: "Previous response with id 'resp_missing' not found.",
        param: 'previous_response_id',
        type: 'invalid_request_error',
      },
    });
  });

  it('supports image generations endpoint', async () => {
    const proxyService = {
      handleChatCompletions: vi.fn().mockResolvedValue({
        choices: [
          {
            message: {
              content: '![img](data:image/png;base64,AAAABBBB)',
            },
          },
        ],
      }),
    };
    const imageQuotaRefresh = vi.fn().mockResolvedValue(undefined);
    const controller = new ProxyController(proxyService as any, undefined, imageQuotaRefresh);
    const reply = createReplyMock();

    await controller.imageGenerations(
      {
        prompt: 'draw a cat',
      },
      reply as any,
    );

    expect(proxyService.handleChatCompletions).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'gemini-3.1-flash-image',
      }),
    );
    expect(reply.status).toHaveBeenCalledWith(200);
    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [
          expect.objectContaining({
            b64_json: 'AAAABBBB',
          }),
        ],
      }),
    );
    expect(imageQuotaRefresh).toHaveBeenCalledOnce();
  });

  it('maps image generation upstream quota errors to 429', async () => {
    const proxyService = {
      handleChatCompletions: vi.fn().mockRejectedValue(new Error('429 quota exceeded')),
    };
    const controller = new ProxyController(proxyService as any);
    const reply = createReplyMock();

    await controller.imageGenerations(
      {
        model: 'gemini-3-pro-image',
        prompt: 'draw a dog',
      },
      reply as any,
    );

    expect(reply.status).toHaveBeenCalledWith(429);
  });

  it('preserves a structured image upstream status when the message has no status hint', async () => {
    const proxyService = {
      handleChatCompletions: vi.fn().mockRejectedValue(
        new UpstreamRequestError({
          message: 'Temporary upstream failure',
          status: 503,
        }),
      ),
    };
    const controller = new ProxyController(proxyService as any);
    const reply = createReplyMock();

    await controller.imageGenerations(
      {
        prompt: 'draw a dog',
      },
      reply as any,
    );

    expect(reply.status).toHaveBeenCalledWith(503);
  });

  it('falls back to Gemini image generation when chat path hits project context error', async () => {
    const proxyService = {
      handleChatCompletions: vi
        .fn()
        .mockRejectedValue(
          new Error(
            'You are currently configured to use a Google Cloud Project but lack a Gemini Code Assist license. (#3501)',
          ),
        ),
      handleGeminiGenerateContent: vi.fn().mockResolvedValue({
        candidates: [
          {
            content: {
              parts: [
                {
                  inlineData: {
                    mimeType: 'image/png',
                    data: 'FALLBACKIMG',
                  },
                },
              ],
            },
          },
        ],
      }),
    };
    const imageQuotaRefresh = vi.fn().mockResolvedValue(undefined);
    const controller = new ProxyController(proxyService as any, undefined, imageQuotaRefresh);
    const reply = createReplyMock();

    await controller.imageGenerations(
      {
        model: 'gemini-3-pro-image',
        prompt: 'draw a fox',
      },
      reply as any,
    );

    expect(proxyService.handleChatCompletions).toHaveBeenCalledOnce();
    expect(proxyService.handleGeminiGenerateContent).toHaveBeenCalledOnce();
    expect(reply.status).toHaveBeenCalledWith(200);
    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [
          expect.objectContaining({
            b64_json: 'FALLBACKIMG',
          }),
        ],
      }),
    );
    expect(imageQuotaRefresh).toHaveBeenCalledOnce();
  });

  it('returns 502 when the direct Gemini image fallback has no inline image', async () => {
    const proxyService = {
      handleChatCompletions: vi
        .fn()
        .mockRejectedValue(
          new Error(
            'You are currently configured to use a Google Cloud Project but lack a Gemini Code Assist license. (#3501)',
          ),
        ),
      handleGeminiGenerateContent: vi.fn().mockResolvedValue({
        candidates: [],
      }),
    };
    const controller = new ProxyController(proxyService as any);
    const reply = createReplyMock();

    await controller.imageGenerations(
      {
        prompt: 'draw a fox',
      },
      reply as any,
    );

    expect(reply.status).toHaveBeenCalledWith(502);
  });

  it('supports image edits endpoint with supplementary image payload', async () => {
    const proxyService = {
      handleChatCompletions: vi.fn().mockResolvedValue({
        choices: [
          {
            message: {
              content: '![img](data:image/png;base64,CCCCDDDD)',
            },
          },
        ],
      }),
    };
    const controller = new ProxyController(proxyService as any);
    const reply = createReplyMock();

    await controller.imageEdits(
      createMultipartRequest([
        { type: 'field', fieldname: 'prompt', value: 'make it brighter' },
        {
          type: 'file',
          fieldname: 'image',
          filename: 'main.png',
          mimetype: 'image/png',
          data: Buffer.from('main-image'),
        },
        {
          type: 'file',
          fieldname: 'mask',
          filename: 'mask.webp',
          mimetype: 'image/webp',
          data: Buffer.from('mask-image'),
        },
        {
          type: 'file',
          fieldname: 'image1',
          filename: 'reference.jpg',
          mimetype: 'image/jpeg',
          data: Buffer.from('reference-image'),
        },
      ]) as any,
      reply as any,
    );

    const request = proxyService.handleChatCompletions.mock.calls[0][0];
    expect(request).toMatchObject({
      model: 'gemini-3.1-flash-image',
      messages: [
        {
          content: [
            {
              type: 'text',
              text: 'make it brighter',
            },
            {
              type: 'image_url',
              image_url: {
                url: `data:image/png;base64,${Buffer.from('main-image').toString('base64')}`,
              },
            },
            {
              type: 'image_url',
              image_url: {
                url: `data:image/webp;base64,${Buffer.from('mask-image').toString('base64')}`,
              },
            },
            {
              type: 'image_url',
              image_url: {
                url: `data:image/jpeg;base64,${Buffer.from('reference-image').toString('base64')}`,
              },
            },
          ],
        },
      ],
    });
    expect(reply.status).toHaveBeenCalledWith(200);
  });

  it('rejects image edits request without multipart boundary', async () => {
    const proxyService = {
      handleChatCompletions: vi.fn(),
    };
    const controller = new ProxyController(proxyService as any);
    const reply = createReplyMock();

    await controller.imageEdits(
      {
        headers: {
          'content-type': 'application/json',
        },
      } as any,
      reply as any,
    );

    expect(proxyService.handleChatCompletions).not.toHaveBeenCalled();
    expect(reply.status).toHaveBeenCalledWith(400);
    expect(reply.send).toHaveBeenCalledWith('Invalid `boundary` for `multipart/form-data` request');
  });

  it('supports audio transcriptions endpoint', async () => {
    const proxyService = {
      handleGeminiGenerateContent: vi.fn().mockResolvedValue({
        candidates: [
          {
            content: {
              parts: [{ text: 'transcribed text' }],
            },
          },
        ],
      }),
    };
    const controller = new ProxyController(proxyService as any);
    const reply = createReplyMock();

    await controller.audioTranscriptions(
      {
        model: 'gemini-2.5-flash',
        file: 'data:audio/mpeg;base64,QUJDRA==',
      },
      {
        headers: {
          'content-type': 'multipart/form-data; boundary=----parity',
        },
      } as any,
      reply as any,
    );

    expect(proxyService.handleGeminiGenerateContent).toHaveBeenCalledOnce();
    expect(reply.status).toHaveBeenCalledWith(200);
    expect(reply.send).toHaveBeenCalledWith({ text: 'transcribed text' });
  });

  it('rejects audio transcription request without multipart boundary', async () => {
    const proxyService = {
      handleGeminiGenerateContent: vi.fn(),
    };
    const controller = new ProxyController(proxyService as any);
    const reply = createReplyMock();

    await controller.audioTranscriptions(
      {
        model: 'gemini-2.5-flash',
        file: 'data:audio/mpeg;base64,QUJDRA==',
      },
      {
        headers: {
          'content-type': 'application/json',
        },
      } as any,
      reply as any,
    );

    expect(proxyService.handleGeminiGenerateContent).not.toHaveBeenCalled();
    expect(reply.status).toHaveBeenCalledWith(400);
    expect(reply.send).toHaveBeenCalledWith('Invalid `boundary` for `multipart/form-data` request');
  });

  it('supports Anthropic messages endpoint', async () => {
    const proxyService = {
      handleAnthropicMessages: vi.fn().mockResolvedValue({
        id: 'msg_1',
        type: 'message',
      }),
    };
    const controller = new AnthropicController(proxyService as any);
    const reply = createReplyMock();

    await controller.anthropicMessages(
      {
        model: 'claude-sonnet-4-5',
        stream: false,
        messages: [{ role: 'user', content: 'hello' }],
      } as any,
      reply as any,
    );

    expect(proxyService.handleAnthropicMessages).toHaveBeenCalledOnce();
    expect(reply.status).toHaveBeenCalledWith(200);
  });
});
