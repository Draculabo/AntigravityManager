import { Logger } from '@nestjs/common';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { UpstreamRequestError } from '@/server/gateway/common/exceptions/upstream-request.exception';
import { SignatureStore } from '@/modules/proxy-gateway/antigravity/SignatureStore';
import {
  createAccount,
  createGateway,
  createLease,
  createUpstream,
} from './proxy-real-path.harness';
import type { AnthropicChatRequest } from '@/server/gateway/common/interfaces/request-interfaces';

vi.mock('@/server/gateway/common/utils/request-user-agent', () => ({
  resolveRequestUserAgent: async () => 'controlled-history-rejection/0.0.0',
  buildContentRequestUserAgent: () => 'controlled-history-rejection/0.0.0',
  resolveLocalInstalledVersion: () => '0.0.0',
}));
beforeEach(() => {
  vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

describe.each([false, true])('signature rejection preserves input, stream=%s', (stream) => {
  it.each(['success-result', 'failed-result', 'next-user', 'parallel-results'] as const)(
    'does not fabricate or retry %s history',
    async (kind) => {
      const error = new UpstreamRequestError({
        status: 400,
        message: 'Invalid thought signature.',
      });
      const upstream = createUpstream({
        generate: () => {
          throw error;
        },
        streamError: error,
      });
      const lease = createLease([
        createAccount('history-rejection-controlled'),
        createAccount('history-rejection-second'),
      ]);
      const clear = vi.spyOn(SignatureStore, 'clearRecoveryScope');
      const messages: AnthropicChatRequest['messages'] = [
        { role: 'user', content: 'controlled question' },
        {
          role: 'assistant',
          content: [
            {
              type: 'thinking',
              thinking: 'private controlled reasoning',
              signature: 'controlled-signature',
            },
            {
              type: 'tool_use',
              id: 'controlled-call',
              name: 'read_file',
              input: { path: 'fixture.txt' },
            },
            ...(kind === 'parallel-results'
              ? [
                  {
                    type: 'tool_use' as const,
                    id: 'controlled-call-2',
                    name: 'read_file',
                    input: { path: 'second.txt' },
                  },
                ]
              : []),
          ],
        },
        {
          role: 'user',
          content:
            kind === 'next-user'
              ? 'new user request; do not assume cancellation'
              : [
                  {
                    type: 'tool_result',
                    tool_use_id: 'controlled-call',
                    content: kind === 'failed-result' ? 'Permission denied' : 'controlled result',
                    is_error: kind === 'failed-result',
                  },
                  ...(kind === 'parallel-results'
                    ? [
                        {
                          type: 'tool_result' as const,
                          tool_use_id: 'controlled-call-2',
                          content: 'second controlled result',
                          is_error: true,
                        },
                      ]
                    : []),
                ],
        },
      ];
      const request: AnthropicChatRequest = {
        model: 'claude-sonnet-4-5',
        max_tokens: 32,
        stream,
        system: '  Preserve system policy.  ',
        messages,
      };
      const before = structuredClone(request);
      const pending = createGateway(upstream, lease).anthropicService.handleAnthropicMessages(
        request,
      );
      if (kind === 'next-user') {
        await expect(pending).rejects.toMatchObject({ reason: 'missing-tool-results' });
        expect(upstream.calls).toEqual([]);
        expect(lease.getNextToken).not.toHaveBeenCalled();
      } else {
        await expect(pending).rejects.toBe(error);
        expect(upstream.calls).toHaveLength(1);
      }
      expect(clear).not.toHaveBeenCalled();
      expect(lease.penalties).toEqual([]);
      expect(request).toStrictEqual(before);
      const sent = JSON.stringify(upstream.calls.map((call) => call.body));
      expect(sent).not.toMatch(
        /System Recovery|Tool execution completed|interrupted by user|Please provide the final result/,
      );
      expect(lease.markModelSuccess).not.toHaveBeenCalled();
    },
  );
});
