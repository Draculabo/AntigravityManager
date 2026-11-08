import { describe, expect, it } from 'vitest';
import {
  createAccount,
  createGateway,
  createLease,
  createUpstream,
  collect,
} from './proxy-real-path.harness';

const args = {
  priority: 2,
  payload: {
    enum: ['', 1, false],
    default: 0,
    const: true,
    $ref: '#/private/input',
    allOf: [{ type: 'integer' }],
  },
};
const parameters = {
  type: 'object',
  properties: { priority: { type: 'integer', enum: [1, 2] }, payload: { type: 'object' } },
};

describe.each(['camel-unary', 'snake-unary', 'camel-stream', 'snake-stream'] as const)(
  '%s native Gemini explicit function choice admission',
  (surface) => {
    it('preserves a satisfiable explicit choice and provider extension', async () => {
      const payload = {
        candidates: [
          { content: { role: 'model', parts: [{ text: 'done' }] }, finishReason: 'STOP' },
        ],
      };
      const upstream = createUpstream({ generate: payload, streamFrames: [{ response: payload }] });
      const service = createGateway(
        upstream,
        createLease([createAccount('valid-native-choice')]),
      ).geminiService;
      const request = {
        contents: [{ role: 'user' as const, parts: [{ text: 'Use the declared function.' }] }],
        tools: [{ functionDeclarations: [{ name: 'read_file', parameters }] }],
        ...(surface.startsWith('camel')
          ? {
              toolConfig: {
                functionCallingConfig: {
                  mode: 'ANY',
                  allowedFunctionNames: ['read_file'],
                  providerOption: 1,
                },
              },
            }
          : {
              tool_config: {
                function_calling_config: {
                  mode: 'ANY',
                  allowed_function_names: ['read_file'],
                  providerOption: 1,
                },
              },
            }),
      };
      if (surface.endsWith('stream')) {
        const stream = await service.handleGeminiStreamGenerateContent('gemini-3-flash', request);
        await collect(stream);
      } else {
        await service.handleGeminiGenerateContent('gemini-3-flash', request);
      }
      const sent = upstream.calls[0]?.body.request;
      expect(surface.startsWith('camel') ? sent?.toolConfig : sent?.tool_config).toMatchObject(
        'toolConfig' in request ? request.toolConfig : request.tool_config,
      );
      expect(upstream.calls).toHaveLength(1);
    });
    it.each([
      { mode: 'ANY', allowedNames: undefined, declare: false },
      { mode: 'ANY', allowedNames: ['undeclared_function'], declare: true },
      { mode: 'ANY', allowedNames: [''], declare: true },
    ])(
      'rejects invalid explicit function selection $mode $allowedNames before account selection',
      async (choice) => {
        const upstream = createUpstream({
          generate: {
            candidates: [
              {
                content: { role: 'model', parts: [{ text: 'should not run' }] },
                finishReason: 'STOP',
              },
            ],
          },
        });
        const lease = createLease([createAccount('native-choice')]);
        const service = createGateway(upstream, lease).geminiService;
        const request = {
          contents: [{ role: 'user' as const, parts: [{ text: 'Use the declared function.' }] }],
          ...(choice.declare
            ? { tools: [{ functionDeclarations: [{ name: 'read_file', parameters }] }] }
            : {}),
          ...(surface.startsWith('camel')
            ? {
                toolConfig: {
                  functionCallingConfig: {
                    mode: choice.mode,
                    allowedFunctionNames: choice.allowedNames,
                  },
                },
              }
            : {
                tool_config: {
                  function_calling_config: {
                    mode: choice.mode,
                    allowed_function_names: choice.allowedNames,
                  },
                },
              }),
        };
        const pending = surface.endsWith('stream')
          ? service.handleGeminiStreamGenerateContent('gemini-3-flash', request)
          : service.handleGeminiGenerateContent('gemini-3-flash', request);
        await expect(pending).rejects.toMatchObject({ status: 400 });
        expect(lease.getNextToken).not.toHaveBeenCalled();
        expect(upstream.calls).toEqual([]);
      },
    );
  },
);

describe.each(['chat', 'responses', 'messages'] as const)(
  '%s ordinary search-named functions',
  (surface) => {
    it.each(['web_search', 'google_search', 'builtin_web_search'])(
      'prepares the declaration for ordinary function %s',
      async (name) => {
        const upstream = createUpstream({
          generate: {
            candidates: [
              { content: { role: 'model', parts: [{ text: 'done' }] }, finishReason: 'STOP' },
            ],
          },
        });
        const gateway = createGateway(
          upstream,
          createLease([createAccount('ordinary-search-tool')]),
        );
        if (surface === 'messages') {
          await gateway.anthropicService.handleAnthropicMessages({
            model: 'gemini-3-flash',
            max_tokens: 16,
            tools: [{ name, input_schema: parameters }],
            messages: [{ role: 'user', content: 'Use the declared ordinary function.' }],
          });
        } else {
          await gateway.openAIService.handleChatCompletions(
            {
              model: 'gemini-3-flash',
              tools: [{ type: 'function', function: { name, parameters } }],
              messages: [{ role: 'user', content: 'Use the declared ordinary function.' }],
            },
            surface === 'responses' ? 'responses' : 'chat-completions',
          );
        }
        expect(upstream.calls[0]?.body.request.tools).toEqual([
          {
            functionDeclarations: [
              {
                name,
                parameters: {
                  ...parameters,
                  properties: {
                    priority: { type: 'string', enum: ['1', '2'] },
                    payload: { type: 'object' },
                  },
                },
              },
            ],
          },
        ]);
        expect(upstream.generateInternal).toHaveBeenCalledOnce();
      },
    );
  },
);

describe.each(['chat', 'responses', 'messages', 'gemini'] as const)(
  '%s schema/runtime separation',
  (surface) => {
    it('normalizes declarations while preserving complete historical and returned runtime argument values', async () => {
      const upstream = createUpstream({
        generate: {
          candidates: [
            {
              content: {
                role: 'model',
                parts: [{ functionCall: { id: 'call-next', name: 'inspect_schema', args } }],
              },
              finishReason: 'STOP',
            },
          ],
        },
      });
      const gateway = createGateway(upstream, createLease([createAccount('schema-boundary')]));
      const beforeArgs = structuredClone(args);
      const beforeParameters = structuredClone(parameters);
      let returned: unknown;
      if (surface === 'gemini') {
        const response = await gateway.geminiService.handleGeminiGenerateContent('gemini-3-flash', {
          tools: [
            {
              functionDeclarations: [
                { name: 'inspect_schema', parameters: { ...parameters, type: 'OBJECT' } },
              ],
            },
          ],
          contents: [
            { role: 'user', parts: [{ text: 'Inspect this data.' }] },
            {
              role: 'model',
              parts: [{ functionCall: { id: 'call-old', name: 'inspect_schema', args } }],
            },
            {
              role: 'user',
              parts: [
                {
                  functionResponse: {
                    id: 'call-old',
                    name: 'inspect_schema',
                    response: { result: 'done' },
                  },
                },
              ],
            },
          ],
        });
        returned = response.candidates?.[0]?.content?.parts[0]?.functionCall?.args;
      } else if (surface === 'messages') {
        const response = await gateway.anthropicService.handleAnthropicMessages({
          model: 'gemini-3-flash',
          max_tokens: 16,
          tools: [{ name: 'inspect_schema', input_schema: parameters }],
          messages: [
            { role: 'user', content: 'Inspect this data.' },
            {
              role: 'assistant',
              content: [{ type: 'tool_use', id: 'call-old', name: 'inspect_schema', input: args }],
            },
            {
              role: 'user',
              content: [{ type: 'tool_result', tool_use_id: 'call-old', content: 'done' }],
            },
          ],
        });
        if (!('content' in response)) {
          throw new Error('Expected a unary Anthropic result');
        }
        returned = response.content.find((block) => block.type === 'tool_use')?.input;
      } else {
        const response = await gateway.openAIService.handleChatCompletions(
          {
            model: 'gemini-3-flash',
            tools: [{ type: 'function', function: { name: 'inspect_schema', parameters } }],
            messages: [
              { role: 'user', content: 'Inspect this data.' },
              {
                role: 'assistant',
                content: null,
                tool_calls: [
                  {
                    id: 'call-old',
                    type: 'function',
                    function: { name: 'inspect_schema', arguments: JSON.stringify(args) },
                  },
                ],
              },
              { role: 'tool', tool_call_id: 'call-old', name: 'inspect_schema', content: 'done' },
            ],
          },
          surface === 'responses' ? 'responses' : 'chat-completions',
        );
        if (!('choices' in response)) {
          throw new Error('Expected a unary OpenAI result');
        }
        returned = JSON.parse(
          response.choices[0]?.message?.tool_calls?.[0]?.function?.arguments ?? 'null',
        );
      }
      const sent = upstream.calls[0]?.body.request;
      const historical = sent?.contents
        .flatMap((content) => content.parts)
        .find((part) => part.functionCall)?.functionCall;
      expect(historical?.args).toEqual(beforeArgs);
      expect(returned).toEqual(beforeArgs);
      expect(sent?.tools?.[0]?.functionDeclarations?.[0]?.parameters).toMatchObject({
        properties: { priority: { type: 'string', enum: ['1', '2'] } },
      });
      expect(args).toEqual(beforeArgs);
      expect(parameters).toEqual(beforeParameters);
      expect(upstream.generateInternal).toHaveBeenCalledOnce();
    });
  },
);
