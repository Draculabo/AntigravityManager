import { afterEach, describe, expect, it, vi } from 'vitest';

import { GeminiController } from '@/server/gateway/modules/gemini/gemini.controller';
import { proxyModelAvailabilityStore } from '@/server/gateway/shared/services/model-availability.service';
import { UpstreamRequestError } from '@/server/gateway/common/exceptions/upstream-request.exception';
import {
  createAccount,
  createGateway,
  createLease,
  createReply,
  createUpstream,
} from './proxy-real-path.harness';

/**
 * `countTokens` on the native surface, over the real chain. The gateway advertises the method
 * in its model list, so answering a constant is worse than not serving it: a client budgeting
 * a context window against the answer overflows it without ever seeing an error.
 */

vi.mock(
  '@/server/gateway/common/utils/request-user-agent',
  async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    resolveRequestUserAgent: async () => 'antigravity-parity-harness/0.0.0',
  }),
);

function countTokensBody(text: string) {
  return { contents: [{ parts: [{ text }], role: 'user' }] };
}

describe('Gemini countTokens', () => {
  afterEach(() => {
    proxyModelAvailabilityStore.clearAccount('acc-1');
  });

  it('answers the count the upstream endpoint returned', async () => {
    const upstream = createUpstream({ countTokens: { totalTokens: 4096 } });
    const lease = createLease([createAccount('acc-1')]);
    const controller = new GeminiController(createGateway(upstream, lease).geminiService);
    const reply = createReply();

    await controller.countTokens(
      'gemini-3-flash',
      countTokensBody('how many tokens is this') as never,
      reply as never,
    );

    expect(reply.status).toHaveBeenCalledWith(200);
    expect(reply.body).toEqual({ totalTokens: 4096 });
  });

  it('sends only the conversation upstream, under a models/ prefixed id', async () => {
    const upstream = createUpstream({ countTokens: { totalTokens: 12 } });
    const lease = createLease([createAccount('acc-1', 'project-42')]);
    const controller = new GeminiController(createGateway(upstream, lease).geminiService);

    await controller.countTokens(
      'gemini-3-flash',
      countTokensBody('count me') as never,
      createReply() as never,
    );

    const sent = upstream.countTokensCalls[0]?.body as {
      request: Record<string, unknown>;
    };
    expect(sent.request.model).toBe('models/gemini-3-flash-agent');
    expect(sent.request.contents).toEqual([{ parts: [{ text: 'count me' }], role: 'user' }]);
    expect(Object.keys(sent.request).sort()).toEqual(['contents', 'model']);
    expect(JSON.stringify(sent)).not.toContain('project-42');
    // Auxiliary callers deliberately do not attach a conversation-scoped upstream session.
    expect(JSON.stringify(sent)).not.toContain('sessionId');
  });

  it('reads the conversation out of a generateContentRequest wrapper too', async () => {
    const upstream = createUpstream({ countTokens: { totalTokens: 7 } });
    const lease = createLease([createAccount('acc-1')]);
    const controller = new GeminiController(createGateway(upstream, lease).geminiService);
    const reply = createReply();

    await controller.countTokens(
      'gemini-3-flash',
      { generateContentRequest: countTokensBody('wrapped') } as never,
      reply as never,
    );

    expect(reply.body).toEqual({ totalTokens: 7 });
    expect(
      (upstream.countTokensCalls[0]?.body as { request: { contents: unknown } }).request.contents,
    ).toEqual([{ parts: [{ text: 'wrapped' }], role: 'user' }]);
  });

  it('refuses a body that carries no conversation instead of counting nothing', async () => {
    const upstream = createUpstream({ countTokens: { totalTokens: 1 } });
    const lease = createLease([createAccount('acc-1')]);
    const controller = new GeminiController(createGateway(upstream, lease).geminiService);
    const reply = createReply();

    await controller.countTokens('gemini-3-flash', {} as never, reply as never);

    expect(reply.status).toHaveBeenCalledWith(400);
    expect(reply.body).toMatchObject({ error: { status: 'INVALID_ARGUMENT' } });
    expect(upstream.countTokensCalls).toHaveLength(0);
  });

  it('returns a bounded local estimate when the upstream omits the count', async () => {
    const upstream = createUpstream({ countTokens: {} });
    const lease = createLease([createAccount('acc-1')]);
    const controller = new GeminiController(createGateway(upstream, lease).geminiService);
    const reply = createReply();

    await controller.countTokens(
      'gemini-3-flash',
      countTokensBody('hello') as never,
      reply as never,
    );

    expect(reply.status).toHaveBeenCalledWith(200);
    expect(reply.header).toHaveBeenCalledWith('X-AGM-Count-Tokens-Source', 'estimated');
    expect(reply.body).toMatchObject({ totalTokens: expect.any(Number) });
    expect((reply.body as { totalTokens: number }).totalTokens).toBeGreaterThan(0);
  });

  it('includes long system prompts, complete tool schemas and tool configuration in fallback estimates', async () => {
    vi.useFakeTimers();
    try {
      const upstream = createUpstream({ countTokens: {} });
      const lease = createLease([createAccount('acc-1')]);
      const controller = new GeminiController(createGateway(upstream, lease).geminiService);
      const base = createReply();

      const basePending = controller.countTokens(
        'gemini-3-flash',
        countTokensBody('hello') as never,
        base as never,
      );
      await vi.runAllTimersAsync();
      await basePending;

      const enriched = createReply();
      const enrichedPending = controller.countTokens(
        'gemini-3-flash',
        {
          contents: [
            {
              role: 'model',
              parts: [
                {
                  functionCall: {
                    args: { query: 'x'.repeat(2000) },
                    name: 'search',
                  },
                },
                {
                  functionResponse: {
                    name: 'search',
                    response: { output: 'x'.repeat(2000) },
                  },
                },
              ],
            },
          ],
          systemInstruction: { parts: [{ text: 'x'.repeat(2000) }] },
          toolConfig: {
            functionCallingConfig: {
              allowedFunctionNames: ['search_' + 'x'.repeat(2000)],
              mode: 'ANY',
            },
          },
          tools: [
            {
              functionDeclarations: [
                {
                  name: 'search',
                  parameters: {
                    properties: { query: { description: 'x'.repeat(2000), type: 'string' } },
                    type: 'object',
                  },
                },
              ],
            },
          ],
        } as never,
        enriched as never,
      );
      await vi.runAllTimersAsync();
      await enrichedPending;

      expect((base.body as { totalTokens: number }).totalTokens).toBeGreaterThan(0);
      expect((enriched.body as { totalTokens: number }).totalTokens).toBeGreaterThan(
        (base.body as { totalTokens: number }).totalTokens,
      );
      expect(enriched.header).toHaveBeenCalledWith('X-AGM-Count-Tokens-Source', 'estimated');
      expect(upstream.countTokensCalls[1]?.body).toMatchObject({
        request: {
          model: 'models/gemini-3-flash-agent',
        },
      });
      expect(
        Object.keys((upstream.countTokensCalls[1]?.body as { request: object }).request).sort(),
      ).toEqual(['contents', 'model']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not turn an unavailable account into an estimated success', async () => {
    const upstream = createUpstream({ countTokens: { totalTokens: 10 } });
    const controller = new GeminiController(createGateway(upstream, createLease([])).geminiService);
    const reply = createReply();

    await controller.countTokens(
      'gemini-3-flash',
      countTokensBody('hello') as never,
      reply as never,
    );

    expect(reply.status).toHaveBeenCalledWith(503);
    expect(reply.header).not.toHaveBeenCalledWith('X-AGM-Count-Tokens-Source', 'estimated');
    expect(upstream.countTokensCalls).toHaveLength(0);
  });

  it('penalises the account and preserves an upstream forbidden response', async () => {
    const upstream = createUpstream({
      countTokens: () => {
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

    await controller.countTokens(
      'gemini-3-flash',
      countTokensBody('hello') as never,
      reply as never,
    );

    expect(reply.status).toHaveBeenCalledWith(403);
    expect(reply.body).toMatchObject({
      error: {
        code: 403,
        status: 'PERMISSION_DENIED',
      },
    });
    expect(lease.penalties).toEqual([{ accountId: 'acc-1', kind: 'forbidden' }]);
  });

  it.each([[429], [503]])(
    'returns a local estimate after retryable upstream status %i',
    async (status) => {
      vi.useFakeTimers();
      try {
        const upstream = createUpstream({
          countTokens: () => {
            throw new UpstreamRequestError({
              message: `Upstream rejected countTokens with ${status}`,
              status,
            });
          },
        });
        const lease = createLease([createAccount('acc-1')]);
        const controller = new GeminiController(createGateway(upstream, lease).geminiService);
        const reply = createReply();

        const pending = controller.countTokens(
          'gemini-3-flash',
          countTokensBody('hello') as never,
          reply as never,
        );
        await vi.runAllTimersAsync();
        await pending;

        expect(reply.status).toHaveBeenCalledWith(200);
        expect(reply.header).toHaveBeenCalledWith('X-AGM-Count-Tokens-Source', 'estimated');
        expect(reply.body).toMatchObject({ totalTokens: expect.any(Number) });
        expect((reply.body as { totalTokens: number }).totalTokens).toBeGreaterThan(0);
      } finally {
        vi.useRealTimers();
      }
    },
  );
});
