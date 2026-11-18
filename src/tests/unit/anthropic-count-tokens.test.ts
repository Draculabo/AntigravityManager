import { afterEach, describe, expect, it, vi } from 'vitest';

import { AnthropicController } from '@/server/gateway/modules/anthropic/anthropic.controller';
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
 * `POST /v1/messages/count_tokens`, over the real chain. The conversation is converted by the
 * same mapper the Messages endpoint uses, so what gets counted is what a real completion would
 * have sent upstream.
 */

vi.mock(
  '@/server/gateway/common/utils/request-user-agent',
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
    expect(reply.header).toHaveBeenCalledWith('X-AGM-Count-Tokens-Source', 'estimated');
    expect(reply.body).toEqual({ input_tokens: expect.any(Number) });
    expect(upstream.countTokensCalls).toEqual([]);
    expect(lease.getNextToken).not.toHaveBeenCalled();
  });

  it('counts the conversation the Messages endpoint would have sent', async () => {
    const upstream = createUpstream({ countTokens: { totalTokens: 5 } });
    const lease = createLease([createAccount('acc-1', 'project-42')]);
    const controller = new AnthropicController(createGateway(upstream, lease).anthropicService);

    const reply = createReply();
    await controller.countTokens(
      {
        messages: [
          { content: 'first', role: 'user' },
          { content: 'second', role: 'assistant' },
        ],
        model: 'claude-sonnet-4-5',
        system: 'You are terse.',
      } as never,
      reply as never,
    );

    expect(reply.status).toHaveBeenCalledWith(200);
    expect(reply.body).toEqual({ input_tokens: expect.any(Number) });
    expect(upstream.countTokensCalls).toEqual([]);
    expect(lease.getNextToken).not.toHaveBeenCalled();
  });

  it('returns a bounded local estimate without consulting upstream counts', async () => {
    const upstream = createUpstream({ countTokens: {} });
    const lease = createLease([createAccount('acc-1')]);
    const controller = new AnthropicController(createGateway(upstream, lease).anthropicService);
    const reply = createReply();

    await controller.countTokens(countTokensBody('hello') as never, reply as never);

    expect(reply.status).toHaveBeenCalledWith(200);
    expect(reply.header).toHaveBeenCalledWith('X-AGM-Count-Tokens-Source', 'estimated');
    expect(reply.body).toMatchObject({ input_tokens: expect.any(Number) });
    expect((reply.body as { input_tokens: number }).input_tokens).toBeGreaterThan(0);
  });

  it('includes long system prompts, tools and tool history in local estimates', async () => {
    vi.useFakeTimers();
    try {
      const upstream = createUpstream({ countTokens: {} });
      const lease = createLease([createAccount('acc-1')]);
      const controller = new AnthropicController(createGateway(upstream, lease).anthropicService);
      const base = createReply();
      const enriched = createReply();

      const basePending = controller.countTokens(countTokensBody('hello') as never, base as never);
      await vi.runAllTimersAsync();
      await basePending;
      const pending = controller.countTokens(
        {
          max_tokens: 32,
          messages: [
            { content: 'Use the search tool.', role: 'user' },
            {
              content: [
                {
                  id: 'call_search',
                  input: { query: 'x'.repeat(2000) },
                  name: 'search',
                  type: 'tool_use',
                },
              ],
              role: 'assistant',
            },
            {
              content: [
                {
                  content: [{ text: 'x'.repeat(2000), type: 'text' }],
                  tool_use_id: 'call_search',
                  type: 'tool_result',
                },
              ],
              role: 'user',
            },
          ],
          model: 'claude-sonnet-4-5',
          system: 'x'.repeat(2000),
          tools: [
            {
              description: 'x'.repeat(2000),
              input_schema: {
                properties: { query: { description: 'x'.repeat(2000), type: 'string' } },
                type: 'object',
              },
              name: 'search',
            },
          ],
        } as never,
        enriched as never,
      );
      await vi.runAllTimersAsync();
      await pending;

      expect((enriched.body as { input_tokens: number }).input_tokens).toBeGreaterThan(
        (base.body as { input_tokens: number }).input_tokens,
      );
      expect(enriched.header).toHaveBeenCalledWith('X-AGM-Count-Tokens-Source', 'estimated');
      expect(upstream.countTokensCalls).toEqual([]);
      expect(lease.getNextToken).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not require an upstream account for local estimation', async () => {
    const upstream = createUpstream({ countTokens: { totalTokens: 10 } });
    const controller = new AnthropicController(
      createGateway(upstream, createLease([])).anthropicService,
    );
    const reply = createReply();

    await controller.countTokens(countTokensBody('hello') as never, reply as never);

    expect(reply.status).toHaveBeenCalledWith(200);
    expect(reply.body).toEqual({ input_tokens: expect.any(Number) });
    expect(reply.header).toHaveBeenCalledWith('X-AGM-Count-Tokens-Source', 'estimated');
    expect(upstream.countTokensCalls).toHaveLength(0);
  });

  it('does not contact or penalize an account during local counting', async () => {
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

    expect(reply.body).toEqual({ input_tokens: expect.any(Number) });
    expect(reply.status).toHaveBeenCalledWith(200);
    expect(lease.penalties).toEqual([]);
    expect(upstream.countTokensCalls).toEqual([]);
  });
});
