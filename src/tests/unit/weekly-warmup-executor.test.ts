import { describe, expect, it, vi } from 'vitest';

import { ProxyGatewayWeeklyWarmupExecutor } from '@/modules/proxy-gateway/weekly-warmup-executor';
import { transformClaudeRequestIn } from '@/modules/proxy-gateway/antigravity/ClaudeRequestMapper';

describe('ProxyGatewayWeeklyWarmupExecutor', () => {
  it('uses the authenticated internal transport without exposing a local HTTP endpoint', async () => {
    const warmupInternal = vi.fn().mockResolvedValue(undefined);
    const executor = new ProxyGatewayWeeklyWarmupExecutor({ warmupInternal });

    await executor.warmup({
      accessToken: 'secret-access-token',
      model: 'claude-sonnet-4-6',
      projectId: ' project-id ',
      upstreamProxyUrl: 'http://127.0.0.1:7890',
    });

    const expected = transformClaudeRequestIn(
      {
        model: 'claude-sonnet-4-6',
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 1,
        stream: false,
      },
      'project-id',
      'antigravity',
    );
    expect(warmupInternal).toHaveBeenCalledExactlyOnceWith(
      {
        ...expected,
        requestId: expect.stringMatching(/^agent\/\d+\/[a-f0-9]{8}$/),
      },
      'secret-access-token',
      'http://127.0.0.1:7890',
      undefined,
    );
  });
});
