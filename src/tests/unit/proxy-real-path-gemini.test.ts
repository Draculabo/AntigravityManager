import { afterEach, describe, expect, it, vi } from 'vitest';
import { Observable } from 'rxjs';

import { GeminiController } from '@/server/gateway/modules/gemini/gemini.controller';
import { proxyModelAvailabilityStore } from '@/server/gateway/shared/services/model-availability.service';
import { UpstreamRequestError } from '@/server/gateway/common/exceptions/upstream-request.exception';
import { resolveGeminiSessionScope } from '@/server/gateway/common/signature-session-scope';
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
 * The same black-box coverage as the other two surfaces, on the Gemini one. What is real and
 * what is faked is documented in `proxy-real-path.harness.ts`.
 *
 * This surface is the closest to the transport, so the interesting question here is not
 * mapping fidelity but that the controller's own routing -- the `model:action` token, the
 * actions it refuses -- still reaches the service, and that an upstream rejection is answered
 * in the envelope a Gemini client parses.
 */

vi.mock(
  '@/server/gateway/common/utils/request-user-agent',
  async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    resolveRequestUserAgent: async () => 'antigravity-parity-harness/0.0.0',
  }),
);

function geminiRequest(text: string) {
  return { contents: [{ parts: [{ text }], role: 'user' }] };
}

describe('real request path, Gemini surface', () => {
  it.each(['generateContent', 'streamGenerateContent'] as const)(
    'rejects a known foreign signature family before selecting an account on %s',
    async (action) => {
      const source = Buffer.from([0x08, 0x04, 0x12, ...Array<number>(80).fill(0x7f)]).toString(
        'base64',
      );
      const upstream = createUpstream({ generate: geminiTextResponse('unreachable') });
      const lease = createLease([createAccount('acc-1')]);
      const controller = new GeminiController(createGateway(upstream, lease).geminiService);
      const reply = createReply();

      await controller.modelAction(
        `gemini-3-flash:${action}`,
        {
          contents: [
            {
              role: 'model',
              parts: [
                {
                  functionCall: { id: 'call-1', name: 'read', args: {} },
                  thoughtSignature: source,
                },
              ],
            },
          ],
        },
        reply as never,
      );

      expect(reply.statusCode).toBe(400);
      expect(reply.body).toEqual({
        error: {
          code: 400,
          message:
            'Thought signature format at contents[0].parts[0] is incompatible with target model family gemini.',
          status: 'INVALID_ARGUMENT',
        },
      });
      expect(lease.getNextToken).not.toHaveBeenCalled();
      expect(upstream.calls).toEqual([]);
    },
  );

  it.each([
    { action: 'generateContent', part: 'thinking' },
    { action: 'streamGenerateContent', part: 'thinking' },
    { action: 'generateContent', part: 'functionCall' },
    { action: 'streamGenerateContent', part: 'functionCall' },
    { action: 'generateContent', part: 'functionResponse' },
    { action: 'streamGenerateContent', part: 'functionResponse' },
  ] as const)(
    'rejects conflicting $part signature aliases before account selection on $action',
    async ({ action, part }) => {
      const upstream = createUpstream({ generate: geminiTextResponse('unreachable') });
      const lease = createLease([]);
      const controller = new GeminiController(createGateway(upstream, lease).geminiService);
      const reply = createReply();
      const request = {
        contents: [
          {
            role: part === 'functionResponse' ? 'user' : 'model',
            parts: [
              {
                ...(part === 'thinking' ? { text: 'reasoning', thought: true } : {}),
                ...(part === 'functionCall'
                  ? { functionCall: { id: 'call-1', name: 'read', args: {} } }
                  : {}),
                ...(part === 'functionResponse'
                  ? { functionResponse: { id: 'call-1', name: 'read', response: { result: 'ok' } } }
                  : {}),
                thoughtSignature: 'synthetic-private-signature-A',
                thought_signature: 'synthetic-private-signature-B',
              },
            ],
          },
        ],
      };
      const before = structuredClone(request);

      await controller.modelAction(`gemini-3-flash:${action}`, request, reply as never);

      expect(reply.status).toHaveBeenCalledWith(400);
      expect(reply.body).toEqual({
        error: {
          code: 400,
          message:
            'Conflicting thoughtSignature and thought_signature at contents[0].parts[0]. Supply one signature value or equivalent aliases.',
          status: 'INVALID_ARGUMENT',
        },
      });
      expect(lease.getNextToken).not.toHaveBeenCalled();
      expect(upstream.calls).toEqual([]);
      expect(request).toEqual(before);
    },
  );

  it.each([
    { model: 'gemini-3-flash', stream: false },
    { model: 'gemini-3-flash', stream: true },
    { model: 'gemini-3.1-flash-image', stream: false },
    { model: 'gemini-3.1-flash-image', stream: true },
  ])('passes scoped account affinity for $model stream=$stream', async ({ model, stream }) => {
    const upstream = createUpstream({
      generate: geminiTextResponse('ok'),
      streamFrames: [geminiStreamFrame(geminiTextResponse('ok'))],
    });
    const lease = createLease([createAccount('acc-1')]);
    const service = createGateway(upstream, lease).geminiService;
    const body = geminiRequest('synthetic task');
    const context = {
      headers: { authorization: 'Bearer synthetic-tenant', 'x-session-id': 'session-a' },
      url: '/v1beta/models/x?session_id=ignored',
    };
    if (stream) {
      await collect(
        await service.handleGeminiStreamGenerateContent(model, body, undefined, context),
      );
    } else {
      await service.handleGeminiGenerateContent(
        model,
        body,
        'generate-content',
        undefined,
        'gemini',
        context,
      );
    }
    expect(lease.getNextToken.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        sessionKey: resolveGeminiSessionScope(body, context.headers, context.url).affinityKey,
      }),
    );
    expect(lease.commitSession).toHaveBeenCalledOnce();
  });
  it('builds a true image-generation wire envelope when requested by the OpenAI fallback', async () => {
    const upstream = createUpstream({ generate: geminiTextResponse('ok') });
    const service = createGateway(upstream, createLease([createAccount('acc-1')])).geminiService;
    const safetySettings = [
      { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'OFF' },
      { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'OFF' },
    ];

    await service.handleGeminiGenerateContent(
      'gemini-3.1-flash-image',
      {
        ...geminiRequest('draw a fox'),
        generationConfig: { imageConfig: { aspectRatio: '16:9', imageSize: '4K' } },
        safetySettings,
      },
      'image_gen',
    );

    expect(upstream.calls[0]?.body).toMatchObject({
      model: 'gemini-3.1-flash-image',
      requestType: 'image_gen',
      request: {
        generationConfig: { imageConfig: { aspectRatio: '16:9', imageSize: '4K' } },
        safetySettings,
      },
    });
    expect(upstream.calls[0]?.body.enabledCreditTypes).toBeUndefined();
  });

  it.each(['generateContent', 'streamGenerateContent'] as const)(
    'normalizes a native system instruction role before the %s upstream request',
    async (action) => {
      const upstream = createUpstream({
        generate: geminiTextResponse('ok'),
        streamFrames: [geminiStreamFrame(geminiTextResponse('ok'))],
      });
      const service = createGateway(upstream, createLease([createAccount('acc-1')])).geminiService;
      const request = {
        ...geminiRequest('hello'),
        systemInstruction: {
          role: 'model',
          parts: [{ text: 'Native instruction.' }],
        },
      };

      if (action === 'generateContent') {
        await service.handleGeminiGenerateContent('gemini-3-flash', request);
      } else {
        await collect(
          (await service.handleGeminiStreamGenerateContent(
            'gemini-3-flash',
            request,
          )) as Observable<string>,
        );
      }

      expect(upstream.calls[0]?.body.request.systemInstruction).toEqual({
        role: 'user',
        parts: [{ text: 'Native instruction.' }],
      });
    },
  );

  it('does not synthesize an absent native system instruction', async () => {
    const upstream = createUpstream({ generate: geminiTextResponse('ok') });
    const service = createGateway(upstream, createLease([createAccount('acc-1')])).geminiService;

    await service.handleGeminiGenerateContent('gemini-3-flash', geminiRequest('hello'));

    expect(upstream.calls[0]?.body.request.systemInstruction).toBeUndefined();
  });

  it.each(['generateContent', 'streamGenerateContent'] as const)(
    'routes canonical Gemini 3.7 to the high physical model with its full tuple on %s',
    async (action) => {
      const upstream = createUpstream({
        generate: geminiTextResponse('ok'),
        streamFrames: [geminiStreamFrame(geminiTextResponse('ok'))],
      });
      const service = createGateway(upstream, createLease([createAccount('acc-1')])).geminiService;
      const request = geminiRequest('hello');

      if (action === 'generateContent') {
        await service.handleGeminiGenerateContent('gemini-3.7-flash', request);
      } else {
        await collect(
          (await service.handleGeminiStreamGenerateContent(
            'gemini-3.7-flash',
            request,
          )) as Observable<string>,
        );
      }

      expect(upstream.calls).toHaveLength(1);
      expect(upstream.calls[0]?.body.model).toBe('gemini-3.7-flash-high');
      expect(upstream.calls[0]?.body.request.generationConfig).toEqual({
        maxOutputTokens: 11024,
        thinkingConfig: {
          includeThoughts: true,
          thinkingBudget: 10000,
        },
      });
    },
  );

  it('keeps the native 3.6-high server profile despite a low budget hint', async () => {
    const upstream = createUpstream({ generate: geminiTextResponse('ok') });
    const service = createGateway(upstream, createLease([createAccount('acc-1')])).geminiService;

    await service.handleGeminiGenerateContent('gemini-3.6-flash-high', {
      ...geminiRequest('hello'),
      generationConfig: {
        thinkingConfig: {
          includeThoughts: true,
          thinkingBudget: 1000,
        },
      },
    });

    expect(upstream.calls[0]?.body.model).toBe('gemini-3.7-flash-high');
    expect(upstream.calls[0]?.body.request.generationConfig).toEqual({
      maxOutputTokens: 11024,
      thinkingConfig: {
        includeThoughts: true,
        thinkingBudget: 10000,
      },
    });
  });

  it('replaces raw thinking controls for a direct native Gemini agent identity', async () => {
    const upstream = createUpstream({ generate: geminiTextResponse('ok') });
    const service = createGateway(upstream, createLease([createAccount('acc-1')])).geminiService;

    await service.handleGeminiGenerateContent('gemini-3-flash-agent', {
      ...geminiRequest('hello'),
      generationConfig: {
        temperature: 0.2,
        thinkingConfig: {
          includeThoughts: false,
          thinkingBudget: 1000,
          thinkingLevel: 'low',
        },
      },
    });

    expect(upstream.calls[0]?.body.model).toBe('gemini-3-flash-agent');
    expect(upstream.calls[0]?.body.request.generationConfig).toEqual({
      temperature: 0.2,
      maxOutputTokens: 11_024,
      thinkingConfig: {
        includeThoughts: true,
        thinkingBudget: 10_000,
      },
    });
  });

  it('passes a Gemini bare-model thinking level into selection and physical resolution', async () => {
    const upstream = createUpstream({ generate: geminiTextResponse('ok') });
    const lease = createLease([createAccount('acc-1')]);
    const service = createGateway(upstream, lease).geminiService;

    await service.handleGeminiGenerateContent('gemini-3.8-flash', {
      ...geminiRequest('Use medium effort.'),
      generationConfig: {
        thinkingConfig: {
          includeThoughts: true,
          thinkingLevel: 'medium',
        },
      },
    });

    expect(lease.getNextToken).toHaveBeenCalledWith(
      expect.objectContaining({
        effort: 'medium',
        model: 'gemini-3.8-flash',
      }),
    );
    expect(lease.resolveDynamicModelForAccount).toHaveBeenCalledWith(
      'acc-1',
      'gemini-3.8-flash',
      'medium',
      false,
    );
  });

  it('rejects an unknown Gemini thinking level before account selection', async () => {
    const upstream = createUpstream({ generate: geminiTextResponse('unreachable') });
    const lease = createLease([createAccount('acc-1')]);
    const controller = new GeminiController(createGateway(upstream, lease).geminiService);
    const reply = createReply();

    await controller.modelAction(
      'gemini-3.8-flash:generateContent',
      {
        ...geminiRequest('Reject this effort.'),
        generationConfig: {
          thinkingConfig: {
            includeThoughts: true,
            thinkingLevel: 'not-a-tier',
          },
        },
      },
      reply as never,
    );

    expect(reply.statusCode).toBe(400);
    expect(reply.body).toEqual({
      error: {
        code: 400,
        message: expect.stringContaining('Unsupported model effort "not-a-tier"'),
        status: 'INVALID_ARGUMENT',
      },
    });
    expect(lease.getNextToken).not.toHaveBeenCalled();
    expect(lease.resolveDynamicModelForAccount).not.toHaveBeenCalled();
    expect(upstream.calls).toEqual([]);
  });

  it('rebinds native variant parameters when the account selects a physical sibling', async () => {
    const upstream = createUpstream({ generate: geminiTextResponse('ok') });
    const lease = createLease([createAccount('acc-1')]);
    lease.resolveDynamicModelForAccount.mockReturnValue('gemini-3.7-flash-medium');
    const service = createGateway(upstream, lease).geminiService;

    await service.handleGeminiGenerateContent('gemini-3.7-flash-low', geminiRequest('hello'));

    expect(upstream.calls[0]?.body.model).toBe('gemini-3.7-flash-medium');
    expect(upstream.calls[0]?.body.request.generationConfig).toEqual({
      maxOutputTokens: 5024,
      thinkingConfig: {
        includeThoughts: true,
        thinkingBudget: 4000,
      },
    });
  });

  it('routes native countTokens for canonical Gemini 3.7 to the high physical model', async () => {
    const upstream = createUpstream({ countTokens: { totalTokens: 7 } });
    const service = createGateway(upstream, createLease([createAccount('acc-1')])).geminiService;

    await expect(
      service.handleGeminiCountTokens('gemini-3.7-flash', geminiRequest('hello')),
    ).resolves.toBe(7);

    expect(upstream.countTokensCalls).toEqual([
      {
        accessToken: 'access-acc-1',
        body: {
          request: {
            contents: [{ parts: [{ text: 'hello' }], role: 'user' }],
            model: 'models/gemini-3.7-flash-high',
          },
        },
      },
    ]);
  });

  it.each(['generateContent', 'streamGenerateContent'] as const)(
    'replays unsigned Flash tool history with both signature fields on %s',
    async (action) => {
      const upstream = createUpstream({
        generate: geminiTextResponse('ok'),
        streamFrames: [geminiStreamFrame(geminiTextResponse('ok'))],
      });
      const service = createGateway(upstream, createLease([createAccount('acc-1')])).geminiService;
      const request = {
        contents: [
          {
            role: 'model',
            parts: [{ functionCall: { name: 'lookup', args: { key: 'fixture' } } }],
          },
          {
            role: 'user',
            parts: [{ functionResponse: { name: 'lookup', response: { result: 'ok' } } }],
          },
        ],
      };
      if (action === 'generateContent') {
        await new GeminiController(service).modelAction(
          'gemini-3.7-flash-high:generateContent',
          request,
          createReply() as never,
        );
      } else {
        await collect(
          (await service.handleGeminiStreamGenerateContent(
            'gemini-3.7-flash-high',
            request,
          )) as Observable<string>,
        );
      }
      expect(upstream.calls).toHaveLength(1);
      const forwardedContents = upstream.calls[0].body.request.contents;
      const callId = forwardedContents[0]?.parts[0]?.functionCall?.id;
      expect(callId).toMatch(/^call_[a-f0-9]{32}$/);
      expect(forwardedContents).toEqual([
        {
          role: 'model',
          parts: [
            {
              functionCall: { id: callId, name: 'lookup', args: { key: 'fixture' } },
            },
          ],
        },
        {
          role: 'user',
          parts: [
            {
              functionResponse: {
                id: callId,
                name: 'lookup',
                response: { result: 'ok' },
              },
            },
          ],
        },
      ]);
      expect(request.contents[0].parts[0]).toEqual({
        functionCall: { name: 'lookup', args: { key: 'fixture' } },
      });
    },
  );

  afterEach(() => {
    proxyModelAvailabilityStore.clearAccount('acc-1');
    proxyModelAvailabilityStore.clearAccount('acc-2');
  });

  it('answers generateContent from an upstream fixture, through every real layer', async () => {
    const upstream = createUpstream({ generate: geminiTextResponse('The weather is cloudy.') });
    const lease = createLease([createAccount('acc-1')]);
    const controller = new GeminiController(createGateway(upstream, lease).geminiService);
    const reply = createReply();

    await controller.modelAction(
      'gemini-3-flash:generateContent',
      geminiRequest('What is the weather?') as never,
      reply as never,
    );

    expect(reply.status).toHaveBeenCalledWith(200);
    expect(reply.body).toMatchObject({
      candidates: [
        {
          content: { parts: [{ text: 'The weather is cloudy.' }], role: 'model' },
          finishReason: 'STOP',
        },
      ],
    });
    expect(upstream.calls[0]?.accessToken).toBe('access-acc-1');
  });

  it('takes the model out of the action token and sends it upstream', async () => {
    const upstream = createUpstream({ generate: geminiTextResponse('ok') });
    const lease = createLease([createAccount('acc-1')]);
    const controller = new GeminiController(createGateway(upstream, lease).geminiService);

    await controller.modelAction(
      'gemini-3-flash:generateContent',
      geminiRequest('hello') as never,
      createReply() as never,
    );

    expect(upstream.calls[0]?.body.model).toBe('gemini-3-flash-agent');
  });

  it.each(['generateContent', 'streamGenerateContent'])(
    'rejects malformed aliases before account selection: %s',
    async (action) => {
      const upstream = createUpstream({ generate: geminiTextResponse('unreachable') });
      const lease = createLease([]);
      const controller = new GeminiController(createGateway(upstream, lease).geminiService);
      const reply = createReply();
      await controller.modelAction(
        `gemini-3-flash:${action}`,
        {
          ...geminiRequest('invalid'),
          tools: [],
          tool_config: { function_calling_config: [] },
        } as never,
        reply as never,
      );
      expect(reply.body).toEqual({
        error: {
          code: 400,
          status: 'INVALID_ARGUMENT',
          message: 'Invalid Gemini tools or tool configuration',
        },
      });
      expect(lease.getNextToken).not.toHaveBeenCalled();
      expect(upstream.calls).toEqual([]);
    },
  );

  it('preserves native tool extensions and normalizes empty tools at the service boundary', async () => {
    const upstream = createUpstream({ generate: geminiTextResponse('ok') });
    const controller = new GeminiController(
      createGateway(upstream, createLease([createAccount('acc-1')])).geminiService,
    );
    const request = {
      ...geminiRequest('hello'),
      tools: [],
      toolConfig: { extension: { value: 1 }, includeServerSideToolInvocations: false },
      tool_config: { function_calling_config: { mode: 'NONE' } },
    };
    await controller.modelAction('gemini-3-flash:generateContent', request, createReply() as never);
    expect(upstream.calls).toHaveLength(1);
    expect(upstream.calls[0]?.body.request.tools).toEqual([]);
    expect(upstream.calls[0]?.body.request.toolConfig).toEqual({
      extension: { value: 1 },
      includeServerSideToolInvocations: true,
    });
    expect(upstream.calls[0]?.body.request.tool_config).toEqual({
      function_calling_config: { mode: 'NONE' },
      include_server_side_tool_invocations: true,
    });
    expect(request.toolConfig.includeServerSideToolInvocations).toBe(false);
  });

  it('streams generateContent to a Gemini client without reaching the mapper of another surface', async () => {
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
    const { geminiService } = createGateway(upstream, lease);

    const result = await geminiService.handleGeminiStreamGenerateContent(
      'models/gemini-3-flash',
      geminiRequest('stream please') as never,
    );
    const payload = await collect(result as Observable<string>);

    expect(payload).toContain('partial ');
    expect(payload).toContain('answer');
    expect(payload).not.toContain('chat.completion');
    expect(payload).not.toContain('message_start');
  });

  it('refuses an action it does not serve without calling upstream', async () => {
    const upstream = createUpstream({ generate: geminiTextResponse('unreachable') });
    const lease = createLease([createAccount('acc-1')]);
    const controller = new GeminiController(createGateway(upstream, lease).geminiService);
    const reply = createReply();

    await controller.modelAction(
      'gemini-3-flash:embedContent',
      geminiRequest('embed me') as never,
      reply as never,
    );

    expect(reply.status).toHaveBeenCalledWith(400);
    expect(reply.body).toMatchObject({ error: { status: 'INVALID_ARGUMENT' } });
    expect(upstream.calls).toHaveLength(0);
  });

  it('answers an upstream rejection in the envelope a Gemini client parses', async () => {
    const upstream = createUpstream({
      generate: () => {
        throw new UpstreamRequestError({
          body: '{"error":{"status":"PERMISSION_DENIED"}}',
          message: 'The caller does not have permission',
          status: 403,
        });
      },
    });
    const lease = createLease([createAccount('acc-1')]);
    const controller = new GeminiController(createGateway(upstream, lease).geminiService);
    const reply = createReply();

    await controller.modelAction(
      'gemini-3-flash:generateContent',
      geminiRequest('hello') as never,
      reply as never,
    );

    expect(reply.body).toMatchObject({ error: { code: expect.any(Number) } });
    expect(lease.penalties).toEqual([{ accountId: 'acc-1', kind: 'forbidden' }]);
  });
});
