import { afterEach, describe, expect, it, vi } from 'vitest';

import { AnthropicController } from '@/modules/proxy-gateway/server/modules/anthropic/anthropic.controller';
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
 * `POST /v1/messages/count_tokens`, over the real chain. The conversation is converted by the
 * same mapper the Messages endpoint uses, so what gets counted is what a real completion would
 * have sent upstream.
 */

vi.mock(
  '@/modules/proxy-gateway/server/common/utils/request-user-agent',
  async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    resolveRequestUserAgent: async () => 'antigravity-parity-harness/0.0.0',
  }),
);

function countTokensBody(text: string) {
  return {
    messages: [{ content: text, role: 'user' }],
    model: 'claude-sonnet-4-5',
  };
}

describe('Anthropic count_tokens', () => {
  afterEach(() => {
    proxyModelAvailabilityStore.clearAccount('acc-1');
  });

  it('answers with input_tokens, the field the Anthropic contract defines', async () => {
    const upstream = createUpstream({ countTokens: { totalTokens: 2048 } });
    const lease = createLease([createAccount('acc-1')]);
    const controller = new AnthropicController(createGateway(upstream, lease).anthropicService);
    const reply = createReply();

    await controller.countTokens(
      countTokensBody('how many tokens is this') as never,
      reply as never,
    );

    expect(reply.status).toHaveBeenCalledWith(200);
    expect(reply.body).toEqual({ input_tokens: 2048 });
  });

  it('counts the conversation the Messages endpoint would have sent', async () => {
    const upstream = createUpstream({ countTokens: { totalTokens: 5 } });
    const lease = createLease([createAccount('acc-1', 'project-42')]);
    const controller = new AnthropicController(createGateway(upstream, lease).anthropicService);

    await controller.countTokens(
      {
        messages: [
          { content: 'first', role: 'user' },
          { content: 'second', role: 'assistant' },
        ],
        model: 'claude-sonnet-4-5',
        system: 'You are terse.',
      } as never,
      createReply() as never,
    );

    const sent = upstream.countTokensCalls[0]?.body as {
      request: { contents: Array<{ parts: Array<{ text?: string }> }>; model: string };
    };
    expect(sent.request.model).toMatch(/^models\//u);
    expect(JSON.stringify(sent.request.contents)).toContain('first');
    expect(JSON.stringify(sent.request.contents)).toContain('second');
    expect(Object.keys(sent.request).sort()).toEqual(['contents', 'model']);
    expect(JSON.stringify(sent)).not.toContain('project-42');
  });

  it('reports a missing count as a failure rather than a fabricated zero', async () => {
    const upstream = createUpstream({ countTokens: {} });
    const lease = createLease([createAccount('acc-1')]);
    const controller = new AnthropicController(createGateway(upstream, lease).anthropicService);
    const reply = createReply();

    await controller.countTokens(countTokensBody('hello') as never, reply as never);

    expect(reply.body).not.toEqual({ input_tokens: 0 });
    expect(reply.body).toMatchObject({ type: 'error' });
  });

  it('penalises the account when upstream rejects the count', async () => {
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
    const controller = new AnthropicController(createGateway(upstream, lease).anthropicService);
    const reply = createReply();

    await controller.countTokens(countTokensBody('hello') as never, reply as never);

    expect(reply.body).toMatchObject({ type: 'error' });
    expect(lease.penalties).toEqual([{ accountId: 'acc-1', kind: 'forbidden' }]);
  });
});
