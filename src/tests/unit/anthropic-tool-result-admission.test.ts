import { describe, expect, it, vi } from 'vitest';
import { Observable } from 'rxjs';
import { AnthropicController } from '@/server/gateway/modules/anthropic/anthropic.controller';
import type { AnthropicChatRequest } from '@/server/gateway/common/interfaces/request-interfaces';
import {
  createAccount,
  createGateway,
  createLease,
  createReply,
  createUpstream,
  collect,
  geminiStreamFrame,
  geminiTextResponse,
} from './proxy-real-path.harness';

vi.mock(
  '@/server/gateway/common/utils/request-user-agent',
  async (importOriginal) => ({
    ...(await importOriginal()),
    resolveRequestUserAgent: async () => 'tool-result-admission-test',
  }),
);

describe('tool-result admission through protocol services', () => {
  it.each([false, true])(
    'rejects orphan Anthropic history before leasing (stream=%s)',
    async (stream) => {
      const upstream = createUpstream({ generate: geminiTextResponse('unused') });
      const lease = createLease([createAccount('acc-1'), createAccount('acc-2')]);
      const { anthropicService } = createGateway(upstream, lease);
      const controller = new AnthropicController(anthropicService);
      const reply = createReply();
      await controller.anthropicMessages(
        {
          model: 'claude-sonnet-4-5',
          max_tokens: 32,
          stream,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'tool_result', tool_use_id: 'secret-id', content: 'secret-output' },
              ],
            },
          ],
        },
        reply as never,
      );
      expect(reply.status).toHaveBeenCalledWith(400);
      expect(reply.body).toEqual({
        type: 'error',
        error: {
          type: 'invalid_request_error',
          message: 'Invalid tool history at messages[0].content[0]: missing-pending-call.',
        },
      });
      expect(lease.getNextToken).not.toHaveBeenCalled();
      expect(lease.penalties).toEqual([]);
      expect(upstream.calls).toEqual([]);
    },
  );

  it('rejects ambiguous pending IDs before dispatch or account selection', async () => {
    const upstream = createUpstream({ generate: geminiTextResponse('unused') });
    const lease = createLease([createAccount('acc-1')]);
    const { anthropicService } = createGateway(upstream, lease);
    await expect(
      anthropicService.handleAnthropicMessages({
        model: 'claude-sonnet-4-5',
        max_tokens: 32,
        messages: [
          {
            role: 'assistant',
            content: [
              { type: 'tool_use', id: 't', name: 'read', input: {} },
              { type: 'tool_use', id: 't', name: 'write', input: {} },
            ],
          },
        ],
      }),
    ).rejects.toMatchObject({ reason: 'duplicate-pending-id' });
    expect(lease.getNextToken).not.toHaveBeenCalled();
    expect(upstream.calls).toEqual([]);
  });

  it('rejects an orphan through the count-tokens entry before leasing', async () => {
    const upstream = createUpstream({ countTokens: { totalTokens: 1 } });
    const lease = createLease([createAccount('acc-1')]);
    const { anthropicService } = createGateway(upstream, lease);
    const request: AnthropicChatRequest = {
      model: 'claude-sonnet-4-5',
      max_tokens: 32,
      messages: [
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'x' }] },
      ],
    };
    await expect(anthropicService.handleAnthropicCountTokens(request)).rejects.toMatchObject({
      reason: 'missing-pending-call',
    });
    expect(lease.getNextToken).not.toHaveBeenCalled();
    expect(upstream.countTokensCalls).toEqual([]);
  });

  it.each([false, true])(
    'does not retry or penalize an orphan OpenAI history (stream=%s)',
    async (stream) => {
      const upstream = createUpstream({ generate: geminiTextResponse('unused') });
      const lease = createLease([createAccount('acc-1'), createAccount('acc-2')]);
      const { openAIService } = createGateway(upstream, lease);
      await expect(
        openAIService.handleChatCompletions({
          model: 'claude-sonnet-4-5',
          stream,
          messages: [{ role: 'tool', tool_call_id: 't', content: 'orphan output' }],
        }),
      ).rejects.toMatchObject({ reason: 'missing-pending-call' });
      expect(lease.getNextToken).not.toHaveBeenCalled();
      expect(lease.penalties).toEqual([]);
      expect(upstream.calls).toEqual([]);
    },
  );

  it.each([false, true])(
    'keeps completed ID reuse through Anthropic generation (stream=%s)',
    async (stream) => {
      const upstream = createUpstream({
        generate: geminiTextResponse('ok'),
        streamFrames: [geminiStreamFrame(geminiTextResponse('ok'))],
      });
      const lease = createLease([createAccount('acc-1')]);
      const { anthropicService } = createGateway(upstream, lease);
      const response = await anthropicService.handleAnthropicMessages({
        model: 'claude-sonnet-4-5',
        max_tokens: 32,
        stream,
        messages: [
          {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 't', name: 'read', input: { path: 'A' } }],
          },
          {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 't', content: 'A output' }],
          },
          {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 't', name: 'write', input: { path: 'B' } }],
          },
          {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 't', content: 'B output' }],
          },
        ],
      });
      if (response instanceof Observable) {
        expect(await collect(response)).toContain('message_stop');
      }
      expect(upstream.calls).toHaveLength(1);
      expect(
        upstream.calls[0]?.body.request.contents.flatMap((message) =>
          message.parts.flatMap((part) => (part.functionResponse ? [part.functionResponse] : [])),
        ),
      ).toEqual([
        { id: 't', name: 'read', response: { result: 'A output' } },
        { id: 't', name: 'write', response: { result: 'B output' } },
      ]);
      expect(lease.penalties).toEqual([]);
    },
  );
});
