import { afterEach, describe, expect, it, vi } from 'vitest';
import { Observable } from 'rxjs';

import { OpenAIOperations } from '@/server/gateway/modules/openai/openai-operations.service';
import {
  ModelAvailabilityService,
  proxyModelAvailabilityStore,
} from '@/server/gateway/shared/services/model-availability.service';
import { ProxyRetryService } from '@/server/gateway/shared/services/proxy-retry.service';
import { UpstreamRequestError } from '@/server/gateway/common/exceptions/upstream-request.exception';
import { AccountLeaseService } from '@/server/gateway/modules/account-lease/account-lease.service';
import {
  collect,
  createAccount,
  createGateway,
  createLease,
  createReply,
  createUpstream,
  geminiStreamFrame,
  geminiTextResponse,
} from './proxy-real-path.harness';

/**
 * Black-box coverage of the real OpenAI chat path, end to end. What is real and what is
 * faked is documented in `proxy-real-path.harness.ts`; the short version is that everything
 * between the controller and the mappers is the production object.
 *
 * A conformance test that mocks the protocol service proves the controller talks to the
 * service. It cannot prove the gateway still answers an OpenAI client correctly, which is
 * what these check.
 */

vi.mock(
  '@/server/gateway/common/utils/request-user-agent',
  async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    resolveRequestUserAgent: async () => 'antigravity-parity-harness/0.0.0',
  }),
);

describe('real request path, OpenAI chat surface', () => {
  afterEach(() => {
    proxyModelAvailabilityStore.clearAccount('acc-1');
    proxyModelAvailabilityStore.clearAccount('acc-2');
  });

  it.each([
    { secondStatus: 429, statusInferred: undefined, expectedStatus: 429 },
    { secondStatus: 503, statusInferred: undefined, expectedStatus: 503 },
    { secondStatus: 429, statusInferred: true as const, expectedStatus: 503 },
  ])(
    'reports $expectedStatus for a cooled-down pool (upstream status $secondStatus, inferred $statusInferred)',
    async ({ secondStatus, statusInferred, expectedStatus }) => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-11-01T00:00:00Z'));
      const accounts = ['acc-1', 'acc-2'].map((id) => createAccount(id));
      const availability = new ModelAvailabilityService();
      const lease = new AccountLeaseService(
        {
          getAccounts: async () => structuredClone(accounts),
          getAccount: async (id) => structuredClone(accounts.find((account) => account.id === id)),
          updateToken: vi.fn(),
          compareAndUpdateToken: vi.fn(),
          updateQuota: vi.fn(),
          mutateHealth: vi.fn(),
        },
        {
          fetchQuota: vi.fn(),
          refreshAccessToken: vi.fn(),
          fetchProjectId: vi.fn(),
          normalizeRefreshedOAuthClientKey: vi.fn(),
        },
        undefined,
        availability,
        undefined,
        null,
      );
      try {
        await lease.loadAccounts();
        await lease.markFromUpstreamError({
          accountIdOrEmail: 'acc-1',
          status: 429,
          body: '{"error":{"code":429,"status":"RESOURCE_EXHAUSTED"}}',
          model: 'gemini-3-flash-agent',
        });
        await lease.markFromUpstreamError({
          accountIdOrEmail: 'acc-2',
          status: secondStatus,
          statusInferred,
          retryAfter: '30',
          model: 'gemini-3-flash-agent',
        });
        vi.setSystemTime(Date.now() + 1250);
        const upstream = createUpstream({ generate: geminiTextResponse('ready') });
        const controller = new OpenAIOperations(
          createGateway(upstream, lease, undefined, availability).openAIService,
        );
        const body = {
          messages: [{ content: 'Hello', role: 'user' }],
          model: 'gemini-3-flash',
          stream: false,
        } as const;
        for (const stream of [false, true]) {
          const reply = createReply();
          await controller.chatCompletions({ ...body, stream } as never, reply as never);
          expect(reply.statusCode).toBe(expectedStatus);
          expect(reply.body).toMatchObject({
            error: { type: expectedStatus === 429 ? 'rate_limit_error' : 'server_error' },
          });
          expect(reply.header).toHaveBeenCalledWith('Retry-After', '4');
        }
        expect(upstream.calls).toHaveLength(0);

        vi.setSystemTime(Date.now() + 4000);
        const recovered = createReply();
        await controller.chatCompletions(body as never, recovered as never);
        expect(recovered.statusCode).toBe(200);
        expect(upstream.calls.map((call) => call.accessToken)).toEqual(['access-acc-1']);
      } finally {
        await lease.onModuleDestroy();
        vi.useRealTimers();
      }
    },
  );

  it('answers an OpenAI client from an upstream fixture, through every real layer', async () => {
    const upstream = createUpstream({ generate: geminiTextResponse('The weather is cloudy.') });
    const lease = createLease([createAccount('acc-1')]);
    const controller = new OpenAIOperations(createGateway(upstream, lease).openAIService);
    const reply = createReply();

    await controller.chatCompletions(
      {
        messages: [{ content: 'What is the weather?', role: 'user' }],
        model: 'gemini-3-flash',
        stream: false,
      } as never,
      reply as never,
    );

    expect(reply.status).toHaveBeenCalledWith(200);
    expect(reply.body).toMatchObject({
      choices: [
        {
          finish_reason: 'stop',
          index: 0,
          message: { content: 'The weather is cloudy.', role: 'assistant' },
        },
      ],
      object: 'chat.completion',
    });
    expect(upstream.calls).toHaveLength(1);
    expect(upstream.calls[0]?.accessToken).toBe('access-acc-1');
    expect(upstream.calls[0]?.body.request.systemInstruction).toBeUndefined();
    expect(upstream.calls[0]?.body.request.contents[0]).toMatchObject({
      role: 'user',
      parts: [{ text: 'What is the weather?' }],
    });
  });

  it('carries the client request through the mapper into the upstream body', async () => {
    const upstream = createUpstream({ generate: geminiTextResponse('ok') });
    const lease = createLease([createAccount('acc-1', 'project-42')]);
    const controller = new OpenAIOperations(createGateway(upstream, lease).openAIService);

    await controller.chatCompletions(
      {
        messages: [
          { content: 'You are terse.', role: 'system' },
          { content: 'Say hello.', role: 'user' },
        ],
        model: 'gemini-3-flash',
        stream: false,
      } as never,
      createReply() as never,
    );

    const sent = JSON.stringify(upstream.calls[0]?.body);
    expect(sent).toContain('project-42');
    expect(sent).toContain('Say hello.');
    expect(sent).toContain('You are terse.');
    expect(upstream.calls[0]?.body.request.systemInstruction).toEqual(
      expect.objectContaining({
        role: 'user',
        parts: expect.arrayContaining([
          expect.objectContaining({ text: expect.stringContaining('You are terse.') }),
        ]),
      }),
    );
  });

  it('keeps the Gemini 3 server profile when an OpenAI client supplies a low raw budget', async () => {
    const upstream = createUpstream({ generate: geminiTextResponse('ok') });
    const lease = createLease([createAccount('acc-1')]);
    const { openAIService } = createGateway(upstream, lease);

    await openAIService.handleChatCompletions({
      messages: [{ content: 'Use the configured profile.', role: 'user' }],
      model: 'gemini-3.7-flash',
      stream: false,
      thinking: {
        budget_tokens: 1000,
        effort: 'low',
        type: 'enabled',
      },
    });

    expect(upstream.calls[0]?.body.model).toBe('gemini-3.7-flash-high');
    expect(upstream.calls[0]?.body.request.generationConfig).toEqual(
      expect.objectContaining({
        maxOutputTokens: 11024,
        thinkingConfig: {
          includeThoughts: true,
          thinkingBudget: 10000,
        },
      }),
    );
  });

  it('passes a bare-model effort into account selection and physical resolution', async () => {
    const upstream = createUpstream({ generate: geminiTextResponse('ok') });
    const lease = createLease([createAccount('acc-1')]);
    const { openAIService } = createGateway(upstream, lease);

    await openAIService.handleChatCompletions({
      messages: [{ content: 'Use a small effort.', role: 'user' }],
      model: 'gemini-3.8-flash',
      reasoning_effort: 'low',
      stream: false,
    });

    expect(lease.getNextToken).toHaveBeenCalledWith(
      expect.objectContaining({
        effort: 'low',
        model: 'gemini-3.8-flash',
      }),
    );
    expect(lease.resolveDynamicModelForAccount).toHaveBeenCalledWith(
      'acc-1',
      'gemini-3.8-flash',
      'low',
      false,
    );
  });

  it('rejects an unknown effort before account selection or an upstream request', async () => {
    const upstream = createUpstream({ generate: geminiTextResponse('unreachable') });
    const lease = createLease([createAccount('acc-1')]);
    const controller = new OpenAIOperations(createGateway(upstream, lease).openAIService);
    const reply = createReply();

    await controller.chatCompletions(
      {
        messages: [{ content: 'Reject this effort.', role: 'user' }],
        model: 'gemini-3.8-flash',
        reasoning: { effort: 'not-a-tier' },
        stream: false,
      } as never,
      reply as never,
    );

    expect(reply.status).toHaveBeenCalledWith(400);
    expect(reply.body).toEqual({
      error: {
        message: expect.stringContaining('Unsupported model effort "not-a-tier"'),
        type: 'invalid_request_error',
        code: 'invalid_model_effort',
        param: null,
      },
    });
    expect(lease.getNextToken).not.toHaveBeenCalled();
    expect(lease.resolveDynamicModelForAccount).not.toHaveBeenCalled();
    expect(upstream.calls).toEqual([]);
  });

  it('replaces raw OpenAI thinking controls for a direct Gemini agent identity', async () => {
    const upstream = createUpstream({ generate: geminiTextResponse('ok') });
    const lease = createLease([createAccount('acc-1')]);
    const { openAIService } = createGateway(upstream, lease);

    await openAIService.handleChatCompletions({
      messages: [{ content: 'Use the configured profile.', role: 'user' }],
      model: 'gemini-3-flash-agent',
      stream: false,
      thinking: {
        budget_tokens: 1000,
        effort: 'low',
        type: 'enabled',
      },
    });

    expect(upstream.calls[0]?.body.model).toBe('gemini-3-flash-agent');
    expect(upstream.calls[0]?.body.request.generationConfig).toEqual(
      expect.objectContaining({
        maxOutputTokens: 11_024,
        thinkingConfig: {
          includeThoughts: true,
          thinkingBudget: 10_000,
        },
      }),
    );
  });

  it('selects image accounts by the clean base model and preserves the physical model upstream', async () => {
    const upstream = createUpstream({ generate: geminiTextResponse('image generated') });
    const lease = createLease([createAccount('acc-1')]);
    lease.resolveDynamicModelForAccount.mockReturnValue('gemini-3.1-pro-image');
    const { openAIService } = createGateway(upstream, lease);

    await openAIService.handleChatCompletions({
      messages: [{ content: 'Generate a product photo.', role: 'user' }],
      model: 'gemini-3-pro-image-16x9-4k',
      stream: false,
    } as never);

    expect(lease.resolveDynamicModelForAccount).toHaveBeenCalledWith(
      'acc-1',
      'gemini-3-pro-image',
      undefined,
      false,
    );
    expect(upstream.calls[0]?.body.model).toBe('gemini-3.1-pro-image');
    expect(upstream.calls[0]?.body.request.generationConfig?.imageConfig).toEqual({
      aspectRatio: '16:9',
      imageSize: '4K',
    });
  });

  it('streams an upstream fixture to an OpenAI client as SSE it can read', async () => {
    const upstream = createUpstream({
      streamFrames: [
        geminiStreamFrame({
          candidates: [{ content: { parts: [{ text: 'partial ' }], role: 'model' } }],
          modelVersion: 'gemini-3-flash',
        }),
        geminiStreamFrame({
          candidates: [
            { content: { parts: [{ text: 'answer' }], role: 'model' }, finishReason: 'STOP' },
          ],
          modelVersion: 'gemini-3-flash',
        }),
      ],
    });
    const lease = createLease([createAccount('acc-1')]);
    const { openAIService } = createGateway(upstream, lease);

    const result = await openAIService.handleChatCompletions({
      messages: [{ content: 'stream please', role: 'user' }],
      model: 'gemini-3-flash',
      stream: true,
    } as never);
    const payload = await collect(result as Observable<string>);

    expect(payload).toContain('"object":"chat.completion.chunk"');
    expect(payload).toContain('partial ');
    expect(payload).toContain('answer');
    expect(payload.trimEnd().endsWith('data: [DONE]')).toBe(true);
  });

  it('moves to the next account when the first one is rejected upstream', async () => {
    let attempt = 0;
    const upstream = createUpstream({
      generate: () => {
        attempt += 1;
        if (attempt === 1) {
          throw new UpstreamRequestError({
            body: '{"error":{"status":"PERMISSION_DENIED"}}',
            message: 'The caller does not have permission',
            status: 403,
          });
        }
        return geminiTextResponse('second account answered');
      },
    });
    const lease = createLease([createAccount('acc-1'), createAccount('acc-2')]);
    const controller = new OpenAIOperations(createGateway(upstream, lease).openAIService);
    const reply = createReply();

    await controller.chatCompletions(
      {
        messages: [{ content: 'hello', role: 'user' }],
        model: 'gemini-3-flash',
        stream: false,
      } as never,
      reply as never,
    );

    expect(lease.penalties).toEqual([{ accountId: 'acc-1', kind: 'forbidden' }]);
    expect(upstream.calls.map((call) => call.accessToken)).toEqual([
      'access-acc-1',
      'access-acc-2',
    ]);
    expect(reply.body).toMatchObject({
      choices: [{ message: { content: 'second account answered' } }],
    });
  });

  it('quarantines a trusted validation 403 and rotates to the next account', async () => {
    let attempt = 0;
    const upstream = createUpstream({
      generate: () => {
        attempt += 1;
        if (attempt === 1) {
          throw new UpstreamRequestError({
            details: [
              {
                domain: 'cloudcode-pa.googleapis.com',
                reason: 'VALIDATION_REQUIRED',
                type: 'type.googleapis.com/google.rpc.ErrorInfo',
              },
              {
                links: [
                  {
                    description: 'Verify your account',
                    url: 'https://accounts.google.com/verify',
                  },
                ],
                type: 'type.googleapis.com/google.rpc.Help',
              },
            ],
            message: 'Permission denied',
            status: 403,
          });
        }
        return geminiTextResponse('answered anyway');
      },
    });
    const lease = createLease([createAccount('acc-1'), createAccount('acc-2')]);
    const controller = new OpenAIOperations(createGateway(upstream, lease).openAIService);

    await controller.chatCompletions(
      {
        messages: [{ content: 'hello', role: 'user' }],
        model: 'gemini-3-flash',
        stream: false,
      } as never,
      createReply() as never,
    );

    expect(lease.penalties).toEqual([]);
    expect(lease.validationQuarantines).toEqual([
      {
        accountId: 'acc-1',
        verificationUrl: 'https://accounts.google.com/verify',
        description: 'Verify your account',
      },
    ]);
    expect(upstream.calls.map((call) => call.accessToken)).toEqual([
      'access-acc-1',
      'access-acc-2',
    ]);
  });

  it('returns the validation 403 when quarantine exhausts the account pool', async () => {
    const upstreamError = new UpstreamRequestError({
      details: [
        {
          domain: 'cloudcode-pa.googleapis.com',
          reason: 'VALIDATION_REQUIRED',
          type: 'type.googleapis.com/google.rpc.ErrorInfo',
        },
      ],
      message: 'Permission denied',
      status: 403,
    });
    const upstream = createUpstream({
      generate: () => {
        throw upstreamError;
      },
    });
    const lease = createLease([createAccount('acc-1')]);
    const controller = new OpenAIOperations(createGateway(upstream, lease).openAIService);
    const reply = createReply();

    await controller.chatCompletions(
      {
        messages: [{ content: 'hello', role: 'user' }],
        model: 'gemini-3-flash',
        stream: false,
      } as never,
      reply as never,
    );

    expect(lease.validationQuarantines).toEqual([expect.objectContaining({ accountId: 'acc-1' })]);
    expect(reply.status).toHaveBeenCalledWith(403);
  });

  it('preserves the terminal upstream 403 when Gemini or Anthropic exhausts the pool', async () => {
    const upstreamError = new UpstreamRequestError({
      body: '{"error":{"status":"PERMISSION_DENIED"}}',
      message: 'The caller does not have permission',
      status: 403,
    });
    const upstream = createUpstream({
      generate: () => {
        throw upstreamError;
      },
    });
    const lease = createLease([createAccount('acc-1')]);
    const { geminiService } = createGateway(upstream, lease);
    const { anthropicService } = createGateway(upstream, createLease([createAccount('acc-1')]));
    const waitBeforeRetry = vi
      .spyOn(ProxyRetryService.prototype, 'waitBeforeRetry')
      .mockResolvedValue(undefined);

    try {
      await expect(
        geminiService.handleGeminiGenerateContent('gemini-3-flash', {
          contents: [{ parts: [{ text: 'hello' }], role: 'user' }],
        } as never),
      ).rejects.toBe(upstreamError);
      await expect(
        anthropicService.handleAnthropicMessages({
          max_tokens: 64,
          messages: [{ content: 'hello', role: 'user' }],
          model: 'gemini-3-flash',
          stream: false,
        } as never),
      ).rejects.toBe(upstreamError);
    } finally {
      waitBeforeRetry.mockRestore();
    }
  });
});
