import { describe, expect, it, vi } from 'vitest';
import {
  createAccount,
  createGateway,
  createLease,
  createReply,
  createUpstream,
} from './proxy-real-path.harness';
import { GeminiController } from '@/server/gateway/modules/gemini/gemini.controller';
import { AnthropicController } from '@/server/gateway/modules/anthropic/anthropic.controller';
import { UpstreamEndpointConfigurationError } from '@/server/gateway/common/exceptions/upstream-endpoint-configuration.exception';

vi.mock('@/server/gateway/common/utils/request-user-agent', async (original) => ({
  ...(await original<
    typeof import('@/server/gateway/common/utils/request-user-agent')
  >()),
  resolveRequestUserAgent: async () => 'antigravity-count-value-fixture',
}));
const contents = [{ role: 'user', parts: [{ text: 'Count the complete request.' }] }];

describe('Count value and coverage source', () => {
  it('reports endpoint configuration failure without count fallback or another account lease', async () => {
    const upstream = createUpstream({});
    const error = new UpstreamEndpointConfigurationError();
    upstream.countTokensInternal.mockRejectedValue(error);
    const lease = createLease([createAccount('config-a'), createAccount('config-b')]);
    const service = createGateway(upstream, lease).geminiService;

    await expect(
      service.handleGeminiCountTokensWithSource('gemini-3-flash', { contents }),
    ).rejects.toBe(error);

    expect(upstream.countTokensInternal).toHaveBeenCalledOnce();
    expect(lease.getNextToken).toHaveBeenCalledOnce();
    expect(lease.markFromUpstreamError).not.toHaveBeenCalled();
    expect(lease.commitSession).not.toHaveBeenCalled();
    expect(lease.markModelSuccess).not.toHaveBeenCalled();
  });
  it.each([-1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    'never publishes invalid count %s as upstream',
    async (totalTokens) => {
      vi.useFakeTimers();
      try {
        const upstream = createUpstream({ countTokens: { totalTokens } });
        const service = createGateway(
          upstream,
          createLease([createAccount('invalid-count')]),
        ).geminiService;
        const pending = service.handleGeminiCountTokensWithSource('gemini-3-flash', { contents });
        const observed = pending.then((value) => value);
        await vi.runAllTimersAsync();
        expect(await observed).toMatchObject({
          source: 'estimated',
          totalTokens: expect.any(Number),
        });
        expect((await observed).totalTokens).toBeGreaterThan(0);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it('retains a valid upstream zero without substituting an estimate', async () => {
    const upstream = createUpstream({ countTokens: { totalTokens: 0 } });
    const service = createGateway(
      upstream,
      createLease([createAccount('zero-count')]),
    ).geminiService;
    await expect(
      service.handleGeminiCountTokensWithSource('gemini-3-flash', { contents }),
    ).resolves.toEqual({ source: 'upstream', totalTokens: 0 });
  });

  it('marks a complete system/tool estimate when upstream only counted contents', async () => {
    const upstream = createUpstream({ countTokens: { totalTokens: 1 } });
    const lease = createLease([createAccount('full-count')]);
    const service = createGateway(upstream, lease).geminiService;
    const reply = createReply();
    await new GeminiController(service).countTokens(
      'gemini-3-flash',
      {
        contents,
        systemInstruction: { parts: [{ text: 's'.repeat(4000) }] },
        tools: [
          {
            functionDeclarations: [
              {
                name: 'inspect',
                parameters: {
                  type: 'object',
                  properties: { name: { type: 'string', description: 'd'.repeat(4000) } },
                },
              },
            ],
          },
        ],
      },
      reply as never,
    );
    expect(reply.status).toHaveBeenCalledWith(200);
    expect(reply.header).toHaveBeenCalledWith('X-AGM-Count-Tokens-Source', 'estimated');
    expect(reply.header).toHaveBeenCalledWith(
      'X-AGM-Count-Tokens-Reason',
      'upstream-contents-only',
    );
    expect(reply.body).toMatchObject({ totalTokens: expect.any(Number) });
    if (!reply.body || typeof reply.body !== 'object' || !('totalTokens' in reply.body)) {
      throw new Error('Missing complete count');
    }
    expect(reply.body.totalTokens).toBeGreaterThan(2000);
    expect(lease.penalties).toEqual([]);
    expect(upstream.countTokensCalls).toHaveLength(1);
    expect(upstream.countTokensCalls[0].body).toEqual({
      request: { model: 'models/gemini-3-flash-agent', contents },
    });
  });

  it('estimates Anthropic system/tools locally without a provider account operation', async () => {
    const upstream = createUpstream({ countTokens: { totalTokens: 1 } });
    const lease = createLease([createAccount('anthropic-full-count')]);
    const service = createGateway(upstream, lease).anthropicService;
    const reply = createReply();
    await new AnthropicController(service).countTokens(
      {
        model: 'claude-sonnet-4-6',
        max_tokens: 100,
        messages: [{ role: 'user', content: 'Count the complete request.' }],
        system: 's'.repeat(4000),
        tools: [
          {
            name: 'inspect',
            input_schema: { type: 'object', properties: { name: { type: 'string' } } },
          },
        ],
      },
      reply as never,
    );
    expect(reply.status).toHaveBeenCalledWith(200);
    expect(reply.header).toHaveBeenCalledWith('X-AGM-Count-Tokens-Source', 'estimated');
    expect(reply.header).toHaveBeenCalledWith('X-AGM-Count-Tokens-Reason', 'anthropic-local');
    expect(lease.penalties).toEqual([]);
    expect(upstream.countTokensCalls).toEqual([]);
    expect(lease.getNextToken).not.toHaveBeenCalled();
  });

  it('does not penalize or retry a local coverage failure after a valid upstream count', async () => {
    const upstream = createUpstream({ countTokens: { totalTokens: 12 } });
    const lease = createLease([createAccount('unknown-full-count')]);
    const service = createGateway(upstream, lease).geminiService;
    await expect(
      service.handleGeminiCountTokensWithSource('gemini-3-flash', {
        contents: [
          {
            role: 'user',
            parts: [
              {
                inlineData: {
                  mimeType: 'application/pdf',
                  data: Buffer.from('%PDF-1.4\ncontrolled').toString('base64'),
                },
              },
            ],
          },
        ],
        systemInstruction: { parts: [{ text: 'Count this too.' }] },
      }),
    ).rejects.toMatchObject({ status: 503 });
    expect(lease.penalties).toEqual([]);
    expect(lease.markModelSuccess).not.toHaveBeenCalled();
    expect(lease.commitSession).not.toHaveBeenCalled();
    expect(upstream.countTokensCalls).toHaveLength(1);
  });

  it('uses provider-covered audio counts and rejects an incomplete local audio estimate', async () => {
    // A RIFF/WAVE header and one 16-bit silent sample. The envelope carries MIME and bytes.
    const audio = Buffer.from(
      '524946462600000057415645666d74201000000001000100401f0000803e00000200100064617461020000000000',
      'hex',
    );
    const input = [
      {
        role: 'user',
        parts: [{ inlineData: { mimeType: 'audio/wav', data: audio.toString('base64') } }],
      },
    ];
    const upstream = createUpstream({ countTokens: { totalTokens: 9 } });
    const lease = createLease([createAccount('audio-count')]);
    const service = createGateway(upstream, lease).geminiService;

    await expect(
      service.handleGeminiCountTokensWithSource('gemini-3-flash', { contents: input }),
    ).resolves.toEqual({ source: 'upstream', totalTokens: 9 });
    await expect(
      service.handleGeminiCountTokensWithSource('gemini-3-flash', {
        contents: input,
        systemInstruction: { parts: [{ text: 'Count instructions too.' }] },
      }),
    ).rejects.toMatchObject({ status: 503 });

    expect(upstream.countTokensCalls).toHaveLength(2);
    expect(lease.markModelSuccess).toHaveBeenCalledOnce();
    expect(lease.penalties).toEqual([]);
  });

  it('does not return an incomplete local fallback for unestimated PDF input', async () => {
    vi.useFakeTimers();
    try {
      const upstream = createUpstream({ countTokens: {} });
      const lease = createLease([createAccount('pdf-count')]);
      const service = createGateway(upstream, lease).geminiService;
      const reply = createReply();
      const pending = new GeminiController(service).countTokens(
        'gemini-3-flash',
        {
          contents: [
            {
              role: 'user',
              parts: [
                {
                  inlineData: {
                    mimeType: 'application/pdf',
                    data: Buffer.from('%PDF-1.4\ncontrolled').toString('base64'),
                  },
                },
              ],
            },
          ],
        },
        reply as never,
      );
      await vi.runAllTimersAsync();
      await pending;
      expect(reply.status).toHaveBeenCalledWith(503);
      expect(reply.header).not.toHaveBeenCalledWith('X-AGM-Count-Tokens-Source', 'estimated');
    } finally {
      vi.useRealTimers();
    }
  });
});
