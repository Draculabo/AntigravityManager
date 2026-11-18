import { BadRequestException, Logger } from '@nestjs/common';
import { Observable } from 'rxjs';
import { prepareGoogleGenerationContents } from '@/server/gateway/common/generation-history';
import { OpenAIOperations } from '@/server/gateway/modules/openai/openai-operations.service';
import { OpenAIResponsesSessionStore } from '@/server/gateway/modules/openai/responses/openai-responses-session.store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createAccount,
  createGateway,
  createLease,
  createUpstream,
  createReply,
  geminiTextResponse,
  collect,
} from './proxy-real-path.harness';
import type {
  AnthropicMessage,
  GeminiContent,
  OpenAIMessage,
} from '@/server/gateway/common/interfaces/request-interfaces';

vi.mock('@/server/gateway/common/utils/request-user-agent', () => ({
  resolveRequestUserAgent: async () => 'controlled-generation-history/0.0.0',
  buildContentRequestUserAgent: () => 'controlled-generation-history/0.0.0',
  resolveLocalInstalledVersion: () => '0.0.0',
}));
type Kind =
  | 'empty'
  | 'whitespace'
  | 'system-only'
  | 'assistant-start'
  | 'missing-result'
  | 'prefill'
  | 'tool-round';
function input(kind: Kind) {
  const chat: OpenAIMessage[] = [];
  const anthropic: AnthropicMessage[] = [];
  const gemini: GeminiContent[] = [];
  if (kind === 'whitespace') {
    chat.push({ role: 'user', content: ' \r\n\t' });
    anthropic.push({ role: 'user', content: ' \r\n\t' });
    gemini.push({ role: 'user', parts: [{ text: ' \r\n\t' }] });
  } else if (kind === 'system-only') {
    chat.push({ role: 'system', content: 'System is not a business request.' });
    anthropic.push({ role: 'system', content: 'System is not a business request.' });
  } else if (kind === 'assistant-start') {
    chat.push({ role: 'assistant', content: 'unanchored assistant' });
    anthropic.push({ role: 'assistant', content: 'unanchored assistant' });
    gemini.push({ role: 'model', parts: [{ text: 'unanchored assistant' }] });
  } else if (kind !== 'empty') {
    if (kind !== 'tool-round') {
      chat.push({ role: 'user', content: 'controlled request' });
      anthropic.push({ role: 'user', content: 'controlled request' });
      gemini.push({ role: 'user', parts: [{ text: 'controlled request' }] });
    }
    if (kind === 'prefill') {
      chat.push({ role: 'assistant', content: 'Partial answer:  ' });
      anthropic.push({ role: 'assistant', content: 'Partial answer:  ' });
      gemini.push({ role: 'model', parts: [{ text: 'Partial answer:  ' }] });
    } else {
      chat.push({
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call-controlled',
            type: 'function',
            function: { name: 'read_file', arguments: '{"path":"fixture.txt"}' },
          },
        ],
      });
      anthropic.push({
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'call-controlled',
            name: 'read_file',
            input: { path: 'fixture.txt' },
          },
        ],
      });
      gemini.push({
        role: 'model',
        parts: [
          {
            functionCall: {
              id: 'call-controlled',
              name: 'read_file',
              args: { path: 'fixture.txt' },
            },
          },
        ],
      });
      if (kind === 'tool-round') {
        chat.push({ role: 'tool', tool_call_id: 'call-controlled', content: 'actual result' });
        anthropic.push({
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'call-controlled', content: 'actual result' },
          ],
        });
        gemini.push({
          role: 'user',
          parts: [
            {
              functionResponse: {
                id: 'call-controlled',
                name: 'read_file',
                response: { result: 'actual result' },
              },
            },
          ],
        });
      }
    }
  }
  return { chat, anthropic, gemini };
}
beforeEach(() => {
  vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  OpenAIResponsesSessionStore.clear();
});

describe.each([false, true])('Responses input boundary, stream=%s', (stream) => {
  it.each(['empty', 'whitespace', 'system-only', 'assistant-start'] as const)(
    'rejects %s without changing its role or inventing a turn',
    async (kind) => {
      const histories = input(kind);
      const upstream = createUpstream({
        generate: geminiTextResponse('answer'),
        streamFrames: [{ response: geminiTextResponse('answer') }],
      });
      const lease = createLease([createAccount('history-controlled')]);
      const operations = new OpenAIOperations(createGateway(upstream, lease).openAIService);
      const reply = createReply();
      await operations.responses(
        { model: 'gemini-3-flash', input: histories.chat, stream, store: false },
        reply as never,
      );
      expect(reply.statusCode).toBe(400);
      expect(lease.getNextToken).not.toHaveBeenCalled();
      expect(upstream.calls).toEqual([]);
    },
  );

  it('retains anchored assistant prefill and adds only the temporary Gemini tail', async () => {
    const histories = input('prefill');
    const original = structuredClone(histories.chat);
    const upstream = createUpstream({
      generate: geminiTextResponse('answer'),
      streamFrames: [{ response: geminiTextResponse('answer') }],
    });
    const lease = createLease([createAccount('history-controlled')]);
    const operations = new OpenAIOperations(createGateway(upstream, lease).openAIService);
    const reply = createReply();
    await operations.responses(
      { model: 'gemini-3-flash', input: histories.chat, stream, store: false },
      reply as never,
    );
    expect(reply.statusCode ?? 200).toBe(200);
    expect(upstream.calls).toHaveLength(1);
    expect(upstream.calls[0].body.request.contents).toEqual([
      { role: 'user', parts: [{ text: 'controlled request' }] },
      { role: 'model', parts: [{ text: 'Partial answer:  ' }] },
      { role: 'user', parts: [{ text: '.' }] },
    ]);
    expect(histories.chat).toStrictEqual(original);
  });
});

describe.each(['chat', 'responses', 'messages', 'gemini'] as const)(
  '%s generation history',
  (protocol) => {
    async function fixture(kind: Kind, stream: boolean, signal?: AbortSignal) {
      const histories = input(kind);
      const before = structuredClone(histories);
      const upstream = createUpstream({
        generate: geminiTextResponse('answer'),
        streamFrames: [{ response: geminiTextResponse('answer') }],
      });
      const lease = createLease([createAccount('history-controlled')]);
      const gateway = createGateway(upstream, lease);
      const execute = () =>
        protocol === 'gemini'
          ? stream
            ? gateway.geminiService.handleGeminiStreamGenerateContent(
                'gemini-3-flash',
                { contents: histories.gemini },
                signal,
              )
            : gateway.geminiService.handleGeminiGenerateContent(
                'gemini-3-flash',
                { contents: histories.gemini },
                'generate-content',
                signal,
              )
          : protocol === 'messages'
            ? gateway.anthropicService.handleAnthropicMessages(
                {
                  model: 'claude-sonnet-4-5',
                  max_tokens: 32,
                  stream,
                  messages: histories.anthropic,
                },
                undefined,
                signal,
              )
            : gateway.openAIService.handleChatCompletions(
                { model: 'gemini-3-flash', stream, messages: histories.chat },
                protocol === 'responses' ? 'responses' : 'chat-completions',
                signal,
              );
      return { histories, before, upstream, lease, execute };
    }
    it.each(['empty', 'whitespace', 'system-only', 'assistant-start', 'missing-result'] as const)(
      'rejects %s before selecting an account',
      async (kind) => {
        for (const stream of [false, true]) {
          const { histories, before, upstream, lease, execute } = await fixture(kind, stream);
          // Drain old behavior in the negative control so no fixture stream/timer remains alive.
          let failure: unknown;
          try {
            const result = await execute();
            if (result instanceof Observable) {
              await collect(result);
            }
          } catch (error) {
            failure = error;
          }
          expect(failure).toBeInstanceOf(BadRequestException);
          expect(lease.getNextToken).not.toHaveBeenCalled();
          expect(upstream.calls).toEqual([]);
          expect(histories).toStrictEqual(before);
        }
      },
    );
    it.each([false, true])(
      'uses one temporary continuation for supported prefill, stream=%s',
      async (stream) => {
        const { histories, before, upstream, execute } = await fixture('prefill', stream);
        const result = await execute();
        if (result instanceof Observable) {
          await collect(result);
        }
        expect(upstream.calls).toHaveLength(1);
        if (protocol === 'messages') {
          expect(upstream.calls[0].body.request.contents.at(-1)).toEqual({
            role: 'model',
            parts: [{ text: 'Partial answer:  ' }],
          });
          expect(JSON.stringify(upstream.calls[0].body)).not.toContain('ok go on');
        } else {
          expect(upstream.calls[0].body.request.contents.at(-1)).toEqual({
            role: 'user',
            parts: [{ text: '.' }],
          });
          expect(upstream.calls[0].body.request.contents.at(-2)?.parts).toEqual([
            { text: 'Partial answer:  ' },
          ]);
        }
        expect(JSON.stringify(upstream.calls[0].body)).not.toContain('Thinking...');
        expect(histories).toStrictEqual(before);
      },
    );
    it('retains a complete leading tool round without inventing a user request', async () => {
      const { histories, before, upstream, execute } = await fixture('tool-round', false);
      await execute();
      expect(upstream.calls[0].body.request.contents).toHaveLength(2);
      expect(
        upstream.calls[0].body.request.contents.at(-1)?.parts[0].functionResponse?.response,
      ).toEqual({ result: 'actual result' });
      expect(histories).toStrictEqual(before);
    });
    it('preserves cancellation precedence before history admission', async () => {
      const controller = new AbortController();
      controller.abort();
      for (const stream of [false, true]) {
        const { execute, lease, upstream } = await fixture('empty', stream, controller.signal);
        await expect(execute()).rejects.toMatchObject({ name: 'AbortError' });
        expect(lease.getNextToken).not.toHaveBeenCalled();
        expect(upstream.calls).toEqual([]);
      }
    });
  },
);

it('counts native assistant input without adding a generation-only continuation', async () => {
  const upstream = createUpstream({ countTokens: { totalTokens: 7 } });
  const gateway = createGateway(upstream, createLease([createAccount('count-history-controlled')]));
  const contents = input('prefill').gemini;
  expect(await gateway.geminiService.handleGeminiCountTokens('gemini-3-flash', { contents })).toBe(
    7,
  );
  expect(upstream.countTokensCalls[0]?.body).toMatchObject({ request: { contents } });
  expect(upstream.calls).toEqual([]);
});

it('prepares an idempotent outbound copy before history hydration can modify parts', () => {
  const contents = input('prefill').gemini;
  const before = structuredClone(contents);
  const prepared = prepareGoogleGenerationContents(contents, 'gemini-3-flash');
  expect(prepareGoogleGenerationContents(prepared, 'gemini-3-flash')).toStrictEqual(prepared);
  prepared[1].parts[0].text = 'controlled hydration mutation';
  expect(contents).toStrictEqual(before);
  expect(prepareGoogleGenerationContents(contents, 'gemini-3-flash')).toStrictEqual([
    ...before,
    { role: 'user', parts: [{ text: '.' }] },
  ]);
});
