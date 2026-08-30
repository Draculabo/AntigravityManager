import { afterEach, describe, expect, it, vi } from 'vitest';
import { Observable } from 'rxjs';

import { GeminiController } from '@/modules/proxy-gateway/server/modules/gemini/gemini.controller';
import { proxyModelAvailabilityStore } from '@/modules/proxy-gateway/server/shared/services/model-availability.service';
import { UpstreamRequestError } from '@/modules/proxy-gateway/server/common/exceptions/upstream-request.exception';
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
  '@/modules/proxy-gateway/server/common/utils/request-user-agent',
  async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    resolveRequestUserAgent: async () => 'antigravity-parity-harness/0.0.0',
  }),
);

function geminiRequest(text: string) {
  return { contents: [{ parts: [{ text }], role: 'user' }] };
}

describe('real request path, Gemini surface', () => {
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

    expect(upstream.calls[0]?.body.model).toBe('gemini-3-flash');
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
      tool_config: { function_calling_config: { mode: 'ANY', allowed_function_names: ['read'] } },
    };
    await controller.modelAction('gemini-3-flash:generateContent', request, createReply() as never);
    expect(upstream.calls[0]?.body.request.tools).toEqual([]);
    expect(upstream.calls[0]?.body.request.toolConfig).toEqual({
      extension: { value: 1 },
      includeServerSideToolInvocations: true,
    });
    expect(upstream.calls[0]?.body.request.tool_config).toEqual({
      function_calling_config: { mode: 'ANY', allowed_function_names: ['read'] },
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
