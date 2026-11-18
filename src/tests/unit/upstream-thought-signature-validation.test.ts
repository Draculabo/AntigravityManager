import { afterEach, describe, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';

import {
  findUpstreamThoughtSignatureConflict,
  UpstreamThoughtSignatureConflictError,
} from '@/server/gateway/common/upstream-thought-signature-validation';
import { SignatureStore } from '@/modules/proxy-gateway/antigravity/SignatureStore';
import { GeminiController } from '@/server/gateway/modules/gemini/gemini.controller';
import { proxyModelAvailabilityStore } from '@/server/gateway/shared/services/model-availability.service';
import {
  createAccount,
  createGateway,
  createLease,
  createReply,
  createUpstream,
  collect,
} from './proxy-real-path.harness';

vi.mock(
  '@/server/gateway/common/utils/request-user-agent',
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import('@/server/gateway/common/utils/request-user-agent')
    >()),
    resolveRequestUserAgent: async () => 'antigravity-parity-harness/0.0.0',
  }),
);

const raw = Buffer.from([0x08, 0x04, 0x12, ...Array<number>(80).fill(0x7f)]).toString('base64');
const wrapped = Buffer.from(raw, 'utf8').toString('base64');
const position = 'candidates[0].content.parts[0]';
const message = `Conflicting upstream thoughtSignature and thought_signature at ${position}.`;

function responseFor(part: object) {
  return { candidates: [{ content: { parts: [part] } }] };
}

describe('upstream signature alias validation', () => {
  it.each([
    undefined,
    null,
    [],
    { candidates: 'invalid' },
    { candidates: [null, {}, { content: null }, { content: { parts: null } }] },
    responseFor({ text: 'answer' }),
    responseFor({ thoughtSignature: 'opaque-A' }),
    responseFor({ thought_signature: 'opaque-B' }),
    responseFor({ thoughtSignature: '', thought_signature: '' }),
    responseFor({ thoughtSignature: 'opaque-A', thought_signature: 'opaque-A' }),
    responseFor({ thoughtSignature: raw, thought_signature: wrapped }),
    responseFor({ thoughtSignature: wrapped, thought_signature: raw }),
  ])('leaves absent, single and equivalent aliases unchanged: %#', (payload) => {
    const before = structuredClone(payload);
    expect(findUpstreamThoughtSignatureConflict(payload)).toBeNull();
    expect(payload).toEqual(before);
  });

  it.each([
    { thoughtSignature: 'private-A', thought_signature: 'private-B' },
    { thoughtSignature: '', thought_signature: 'private-B' },
    { thoughtSignature: 'private-A ', thought_signature: 'private-A' },
    { thoughtSignature: null, thought_signature: 'private-B' },
    { thoughtSignature: 3, thought_signature: 3 },
  ])('reports a safe exact error for ambiguous aliases: %#', (part) => {
    for (const payload of [responseFor(part), { response: responseFor(part) }]) {
      const before = structuredClone(payload);
      const result = findUpstreamThoughtSignatureConflict(payload);
      expect(result).toBeInstanceOf(UpstreamThoughtSignatureConflictError);
      expect(result?.getResponse()).toEqual({
        message,
        error: 'Bad Gateway',
        statusCode: 502,
      });
      expect(payload).toEqual(before);
    }
  });

  it('inspects later parts and the envelope even when both supported containers exist', () => {
    const payload = {
      candidates: [],
      response: {
        candidates: [
          {},
          {
            content: {
              parts: [{}, { thoughtSignature: 'private-A', thought_signature: 'private-B' }],
            },
          },
        ],
      },
    };
    expect(findUpstreamThoughtSignatureConflict(payload)?.message).toBe(
      'Conflicting upstream thoughtSignature and thought_signature at candidates[1].content.parts[1].',
    );
  });
});

describe('nonreplayable upstream signature conflict through shared protocol services', () => {
  afterEach(() => {
    for (const id of ['acc-1', 'acc-2']) {
      proxyModelAvailabilityStore.clearAccount(id);
    }
    SignatureStore.clear();
  });

  it.each([
    { protocol: 'gemini', stream: false },
    { protocol: 'gemini', stream: true },
    { protocol: 'anthropic', stream: false },
    { protocol: 'anthropic', stream: true },
    { protocol: 'chat-completions', stream: false },
    { protocol: 'chat-completions', stream: true },
    { protocol: 'responses', stream: false },
    { protocol: 'responses', stream: true },
  ] as const)(
    '$protocol/$stream preserves the typed error without fallback, penalty or account rotation',
    async ({ protocol, stream }) => {
      const error = new UpstreamThoughtSignatureConflictError(position);
      const upstream = createUpstream({
        generate: () => {
          throw error;
        },
        streamError: error,
      });
      const lease = createLease([createAccount('acc-1'), createAccount('acc-2')]);
      const gateway = createGateway(upstream, lease);
      const operation =
        protocol === 'gemini'
          ? stream
            ? gateway.geminiService.handleGeminiStreamGenerateContent('gemini-3-flash', {
                contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
              })
            : gateway.geminiService.handleGeminiGenerateContent('gemini-3-flash', {
                contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
              })
          : protocol === 'anthropic'
            ? gateway.anthropicService.handleAnthropicMessages({
                model: 'claude-sonnet-4-5',
                max_tokens: 128,
                messages: [{ role: 'user', content: 'hello' }],
                stream,
              })
            : gateway.openAIService.handleChatCompletions(
                {
                  model: 'claude-sonnet-4-5',
                  messages: [{ role: 'user', content: 'hello' }],
                  stream,
                },
                protocol,
              );

      await expect(operation).rejects.toBe(error);
      expect(upstream.calls.map((call) => call.kind)).toEqual([stream ? 'stream' : 'generate']);
      expect(lease.getNextToken).toHaveBeenCalledTimes(1);
      expect(lease.penalties).toEqual([]);
      expect(lease.commitSession).not.toHaveBeenCalled();
      expect(lease.markModelSuccess).not.toHaveBeenCalled();
    },
  );

  it('returns the Gemini 502 envelope without exposing conflicting values', async () => {
    const upstream = createUpstream({
      generate: () => {
        throw new UpstreamThoughtSignatureConflictError(position);
      },
    });
    const lease = createLease([createAccount('acc-1'), createAccount('acc-2')]);
    const controller = new GeminiController(createGateway(upstream, lease).geminiService);
    const reply = createReply();
    await controller.modelAction(
      'gemini-3-flash:generateContent',
      { contents: [{ role: 'user', parts: [{ text: 'hello' }] }] },
      reply as never,
    );
    expect(reply.statusCode).toBe(502);
    expect(reply.body).toEqual({ error: { code: 502, message, status: 'INTERNAL' } });
    expect(upstream.calls).toHaveLength(1);
    expect(lease.penalties).toEqual([]);
  });

  it('preserves a safe typed native stream failure before the first released frame', async () => {
    const error = new UpstreamThoughtSignatureConflictError(position);
    const source = new Readable({
      read() {
        this.destroy(error);
      },
    });
    const upstream = createUpstream({});
    upstream.streamGenerateInternal.mockResolvedValueOnce(source);
    const lease = createLease([createAccount('acc-1'), createAccount('acc-2')]);
    const gateway = createGateway(upstream, lease);
    const stream = await gateway.geminiService.handleGeminiStreamGenerateContent('gemini-3-flash', {
      contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
    });
    await expect(collect(stream)).rejects.toBe(error);
    expect(lease.penalties).toEqual([]);
    expect(upstream.streamGenerateInternal).toHaveBeenCalledTimes(1);
    expect(source.destroyed).toBe(true);
  });
});
