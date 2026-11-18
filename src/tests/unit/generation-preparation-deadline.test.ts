import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { GeminiController } from '@/server/gateway/modules/gemini/gemini.controller';
import { AnthropicController } from '@/server/gateway/modules/anthropic/anthropic.controller';
import { OpenAIOperations } from '@/server/gateway/modules/openai/openai-operations.service';
import type { GeminiService } from '@/server/gateway/modules/gemini/gemini.service';
import type { AnthropicService } from '@/server/gateway/modules/anthropic/anthropic.service';
import type { OpenAIService } from '@/server/gateway/modules/openai/openai.service';
import {
  createAccount,
  createGateway,
  createLease,
  createReply,
  createUpstream,
} from './proxy-real-path.harness';
import { UpstreamRequestError } from '@/server/gateway/common/exceptions/upstream-request.exception';
import { DEFAULT_APP_CONFIG } from '@/modules/config/types';
import { setServerConfig } from '@/server/server-config';

const expansion = vi.hoisted(() => ({ wait: Promise.resolve() }));
vi.mock(
  '@/server/gateway/modules/files/file-reference-expander',
  async (original) => ({
    ...(await original<
      typeof import('@/server/gateway/modules/files/file-reference-expander')
    >()),
    expandFileReferences: async (body: unknown) => {
      await expansion.wait;
      return body;
    },
  }),
);
beforeEach(() => {
  vi.useFakeTimers();
  setServerConfig({ ...DEFAULT_APP_CONFIG.proxy, generation_timeout: 1 });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  setServerConfig(DEFAULT_APP_CONFIG.proxy);
});

it.each(['chat', 'responses', 'messages', 'gemini'] as const)(
  'includes file expansion in the %s controller deadline and rejects late provider dispatch',
  async (surface) => {
    let release: () => void = () => undefined;
    expansion.wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const service = {
      handleChatCompletions: vi.fn(),
      handleAnthropicMessages: vi.fn(),
      handleGeminiGenerateContent: vi.fn(),
    };
    const reply = createReply();
    const messages = [{ role: 'user' as const, content: 'Controlled file expansion.' }];
    const operations = new OpenAIOperations(service as unknown as OpenAIService);
    const request =
      surface === 'gemini'
        ? new GeminiController(service as unknown as GeminiService).modelAction(
            'fixture:generateContent',
            { contents: [] },
            reply as never,
          )
        : surface === 'messages'
          ? new AnthropicController(service as unknown as AnthropicService).anthropicMessages(
              { model: 'fixture', max_tokens: 16, messages },
              reply as never,
            )
          : surface === 'responses'
            ? operations.responses({ model: 'fixture', input: 'controlled' }, reply as never)
            : operations.chatCompletions({ model: 'fixture', messages }, reply as never);
    try {
      await vi.advanceTimersByTimeAsync(1001);
      expect(reply.statusCode).toBe(504);
      await request;
    } finally {
      release();
      await request;
    }
    await vi.advanceTimersByTimeAsync(0);
    expect(service.handleChatCompletions).not.toHaveBeenCalled();
    expect(service.handleAnthropicMessages).not.toHaveBeenCalled();
    expect(service.handleGeminiGenerateContent).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  },
);

it('includes Responses history preparation without dispatching its late result', async () => {
  expansion.wait = Promise.resolve();
  const service = { handleChatCompletions: vi.fn() };
  const operations = new OpenAIOperations(service as unknown as OpenAIService);
  let release: (value: null) => void = () => undefined;
  vi.spyOn(operations, 'prepareResponsesRequest').mockImplementation(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const reply = createReply();
  const request = operations.responses({ model: 'fixture', input: 'controlled' }, reply as never);
  await vi.advanceTimersByTimeAsync(1001);
  expect(reply.statusCode).toBe(504);
  await request;
  release(null);
  await vi.advanceTimersByTimeAsync(0);
  expect(service.handleChatCompletions).not.toHaveBeenCalled();
  expect(reply.send).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it.each(['completions', 'images'] as const)(
  'bounds the %s adapter waiter and discards late success',
  async (surface) => {
    const service = createGateway(createUpstream({}), createLease([])).openAIService;
    let release: (
      value: Awaited<ReturnType<OpenAIService['handleChatCompletions']>>,
    ) => void = () => undefined;
    const chat = vi.spyOn(service, 'handleChatCompletions').mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const fallback = vi.spyOn(service, 'handleGeminiGenerateContent');
    const operations = new OpenAIOperations(service);
    const reply = createReply();
    const pending =
      surface === 'completions'
        ? operations.completions({ prompt: 'Controlled completion.' }, reply as never)
        : operations.imageGenerations({ prompt: 'Controlled image.' }, reply as never);

    try {
      await vi.advanceTimersByTimeAsync(999);
      expect(reply.send).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(reply.statusCode).toBe(504);
      await pending;
      expect(chat.mock.calls[0]?.[2]?.aborted).toBe(true);
    } finally {
      release({
        id: 'late',
        object: 'chat.completion',
        created: 0,
        model: 'fixture',
        choices: [],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      });
      await pending;
    }
    await vi.advanceTimersByTimeAsync(0);
    expect(reply.send).toHaveBeenCalledOnce();
    expect(fallback).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  },
);

it('shares the remaining image budget across protocol fallback and rejects its late result', async () => {
  const service = createGateway(createUpstream({}), createLease([])).openAIService;
  const chat = vi.spyOn(service, 'handleChatCompletions').mockImplementation(
    () =>
      new Promise((_resolve, reject) => {
        setTimeout(
          () =>
            reject(
              new Error(
                'You are currently configured to use a Google Cloud Project but lack a Gemini Code Assist license. (#3501)',
              ),
            ),
          600,
        );
      }),
  );
  let release: (
    value: Awaited<ReturnType<OpenAIService['handleGeminiGenerateContent']>>,
  ) => void = () => undefined;
  const fallback = vi.spyOn(service, 'handleGeminiGenerateContent').mockImplementation(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const quotaRefresh = vi.fn().mockResolvedValue(undefined);
  const operations = new OpenAIOperations(service, undefined, quotaRefresh);
  const reply = createReply();
  const pending = operations.imageGenerations({ prompt: 'Controlled image.' }, reply as never);
  try {
    await vi.advanceTimersByTimeAsync(600);
    expect(fallback).toHaveBeenCalledOnce();
    expect(fallback.mock.calls[0]?.[3]).toBe(chat.mock.calls[0]?.[2]);
    await vi.advanceTimersByTimeAsync(399);
    expect(reply.send).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(reply.statusCode).toBe(504);
    await pending;
  } finally {
    release({
      candidates: [
        {
          content: {
            role: 'model',
            parts: [{ inlineData: { mimeType: 'image/png', data: 'LATE' } }],
          },
        },
      ],
    });
    await pending;
  }
  await vi.advanceTimersByTimeAsync(0);
  expect(reply.send).toHaveBeenCalledOnce();
  expect(quotaRefresh).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it.each([
  { message: 'The requested project was not found', status: 403 },
  { message: 'Resource projects/unverified-project could not be found', status: 404 },
  {
    message:
      'You are currently configured to use a Google Cloud Project but lack a Gemini Code Assist license. (#3501)',
    status: 503,
  },
])(
  'preserves an image error without authorizing another protocol for $status $message',
  async (failure) => {
    const service = createGateway(createUpstream({}), createLease([])).openAIService;
    vi.spyOn(service, 'handleChatCompletions').mockRejectedValue(new UpstreamRequestError(failure));
    const fallback = vi.spyOn(service, 'handleGeminiGenerateContent');
    const reply = createReply();
    await new OpenAIOperations(service).imageGenerations(
      { prompt: 'Controlled image.' },
      reply as never,
    );
    expect(reply.statusCode).toBe(failure.status);
    expect(fallback).not.toHaveBeenCalled();
    expect(reply.send).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  },
);

it('retains one project recovery allowance across real Chat and image protocol execution', async () => {
  setServerConfig({ ...DEFAULT_APP_CONFIG.proxy, generation_timeout: 10 });
  const upstream = createUpstream({
    generate: () => {
      throw new UpstreamRequestError({
        status: 403,
        message:
          'You are currently configured to use a Google Cloud Project but lack a Gemini Code Assist license. (#3501)',
      });
    },
  });
  const service = createGateway(
    upstream,
    createLease([createAccount('image-owner', 'billing-project')]),
  ).openAIService;
  const fallback = vi.spyOn(service, 'handleGeminiGenerateContent');
  const reply = createReply();
  const pending = new OpenAIOperations(service).imageGenerations(
    { prompt: 'Controlled image.' },
    reply as never,
  );
  await vi.advanceTimersByTimeAsync(9999);
  await pending;
  expect(upstream.calls.map((call) => call.body.project)).toEqual(['billing-project', undefined]);
  expect(fallback).not.toHaveBeenCalled();
  expect(reply.statusCode).toBe(403);
  expect(reply.send).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});
