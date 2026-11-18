import { Observable } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_APP_CONFIG } from '@/modules/config/types';
import { getServerConfig, setServerConfig } from '@/server/server-config';
import {
  collect,
  createAccount,
  createGateway,
  createLease,
  createUpstream,
  geminiTextResponse,
} from './proxy-real-path.harness';

vi.mock('@/server/gateway/common/utils/request-user-agent', () => ({
  resolveRequestUserAgent: async () => 'controlled-prompt-snapshot/0.0.0',
  buildContentRequestUserAgent: () => 'controlled-prompt-snapshot/0.0.0',
  resolveLocalInstalledVersion: () => '0.0.0',
}));
const previous = getServerConfig() ?? DEFAULT_APP_CONFIG.proxy;
afterEach(() => {
  setServerConfig(previous);
  vi.restoreAllMocks();
});
function configure(content: string | null) {
  setServerConfig({
    ...DEFAULT_APP_CONFIG.proxy,
    global_system_prompt: { enabled: content !== null, content: content ?? '' },
  });
}

describe.each(['chat', 'responses', 'messages', 'gemini'] as const)(
  '%s global prompt snapshot',
  (protocol) => {
    it.each([
      { stream: false, initial: '  initial fixture policy  ' },
      { stream: true, initial: '  initial fixture policy  ' },
      { stream: false, initial: null },
      { stream: true, initial: null },
    ])(
      'pins configuration before leasing and observes the next request, %j',
      async ({ stream, initial }) => {
        const account = createAccount('controlled-snapshot');
        const lease = createLease([account]);
        lease.getNextToken.mockImplementationOnce(async () => {
          configure('new fixture policy');
          return account;
        });
        const upstream = createUpstream({
          generate: geminiTextResponse('answer'),
          streamFrames: [{ response: geminiTextResponse('answer') }],
        });
        const gateway = createGateway(upstream, lease);
        const execute = async () => {
          const result =
            protocol === 'gemini'
              ? stream
                ? await gateway.geminiService.handleGeminiStreamGenerateContent('gemini-3-flash', {
                    contents: [{ role: 'user', parts: [{ text: 'fixture request' }] }],
                  })
                : await gateway.geminiService.handleGeminiGenerateContent('gemini-3-flash', {
                    contents: [{ role: 'user', parts: [{ text: 'fixture request' }] }],
                  })
              : protocol === 'messages'
                ? await gateway.anthropicService.handleAnthropicMessages({
                    model: 'claude-sonnet-4-5',
                    max_tokens: 32,
                    stream,
                    messages: [{ role: 'user', content: 'fixture request' }],
                  })
                : await gateway.openAIService.handleChatCompletions(
                    {
                      model: 'gemini-3-flash',
                      stream,
                      messages: [{ role: 'user', content: 'fixture request' }],
                    },
                    protocol === 'responses' ? 'responses' : 'chat-completions',
                  );
          if (result instanceof Observable) {
            await collect(result);
          }
        };
        configure(initial);
        await execute();
        await execute();
        expect(upstream.calls).toHaveLength(2);
        expect(
          upstream.calls.map((call) => call.body.request.systemInstruction?.parts[0].text),
        ).toEqual([
          initial === null
            ? undefined
            : '<global_system_prompt>\n  initial fixture policy  \n</global_system_prompt>',
          '<global_system_prompt>\nnew fixture policy\n</global_system_prompt>',
        ]);
      },
    );
  },
);
