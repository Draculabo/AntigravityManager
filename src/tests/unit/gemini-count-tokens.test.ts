import { afterEach, describe, expect, it, vi } from 'vitest';

import { GeminiController } from '@/modules/proxy-gateway/server/modules/gemini/gemini.controller';
import { proxyModelAvailabilityStore } from '@/modules/proxy-gateway/server/shared/services/model-availability.service';
import { UpstreamRequestError } from '@/modules/proxy-gateway/server/common/exceptions/upstream-request.exception';
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
  '@/modules/proxy-gateway/server/common/utils/request-user-agent',
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
    expect(sent.request.model).toBe('models/gemini-3-flash');
    expect(sent.request.contents).toEqual([{ parts: [{ text: 'count me' }], role: 'user' }]);
    expect(Object.keys(sent.request).sort()).toEqual(['contents', 'model']);
    expect(JSON.stringify(sent)).not.toContain('project-42');
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

  it('reports a missing count as an upstream failure rather than a fabricated zero', async () => {
    const upstream = createUpstream({ countTokens: {} });
    const lease = createLease([createAccount('acc-1')]);
    const controller = new GeminiController(createGateway(upstream, lease).geminiService);
    const reply = createReply();

    await controller.countTokens(
      'gemini-3-flash',
      countTokensBody('hello') as never,
      reply as never,
    );

    expect(reply.body).not.toEqual({ totalTokens: 0 });
    expect(reply.body).toMatchObject({ error: expect.objectContaining({ code: 500 }) });
  });

  it('penalises the account and reports the failure when upstream rejects the count', async () => {
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

    expect(reply.body).toMatchObject({ error: expect.objectContaining({ code: 500 }) });
    expect(lease.penalties).toEqual([{ accountId: 'acc-1', kind: 'forbidden' }]);
  });
});
