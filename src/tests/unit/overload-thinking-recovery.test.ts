import { performance } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';
import type {
  GeminiInternalRequest,
  ThinkingGeminiConfig,
} from '@/modules/proxy-gateway/antigravity/types';
import { UpstreamRequestError } from '@/server/gateway/common/exceptions/upstream-request.exception';
import { GenerationDeadlineExceededError } from '@/server/gateway/common/exceptions/generation-deadline.exception';
import { OverloadThinkingRecovery } from '@/server/gateway/common/overload-thinking-recovery';

function request(
  model = 'gemini-3-flash',
  thinking: ThinkingGeminiConfig = {
    includeThoughts: true,
    thinkingBudget: -1,
  },
): GeminiInternalRequest {
  return {
    model,
    project: 'synthetic-project',
    requestId: 'synthetic-request',
    userAgent: 'synthetic-agent',
    requestType: 'generate-content',
    request: {
      contents: [{ role: 'user', parts: [{ text: 'Explain the fixture.' }] }],
      generationConfig: { temperature: 0.3, maxOutputTokens: 8192, thinkingConfig: thinking },
    },
  };
}

const overload = new UpstreamRequestError({ status: 503, message: 'Service unavailable' });
const capacity = new UpstreamRequestError({
  status: 504,
  message: 'No capacity available for model',
});

describe('upstream overload thinking recovery', () => {
  it('downgrades a final Gemini HIGH request on a plain upstream 503', () => {
    const body = request('gemini-3.8-flash-high', { includeThoughts: true, thinkingLevel: 'HIGH' });
    const recovery = new OverloadThinkingRecovery().admit(overload, body);
    expect(recovery).toMatchObject({
      kind: 'degrade_thinking',
      body: {
        model: 'gemini-3.8-flash-medium',
        request: { generationConfig: { thinkingConfig: { thinkingLevel: 'MEDIUM' } } },
      },
    });
    expect(body.model).toBe('gemini-3.8-flash-high');
    expect(body.request.generationConfig?.thinkingConfig?.thinkingLevel).toBe('HIGH');
  });

  it.each([-1, 12000, undefined])('reduces budget %s once across the request', (thinkingBudget) => {
    const body = request('claude-sonnet-4-6', { includeThoughts: true, thinkingBudget });
    const before = structuredClone(body);
    const recovery = new OverloadThinkingRecovery();
    expect(recovery.admit(overload, body)?.body).toEqual({
      ...before,
      request: {
        ...before.request,
        generationConfig: {
          ...before.request.generationConfig,
          thinkingConfig: { includeThoughts: true, thinkingBudget: 4000 },
        },
      },
    });
    expect(body).toEqual(before);
    expect(recovery.admit(overload, body)).toBeUndefined();
  });

  it.each([
    'gemini-3.8-flash',
    'gemini-3.8-flash-tiered',
    'gemini-3.8-flash-low',
    'gemini-3.8-flash-medium',
  ])(
    'promotes %s for model capacity exhaustion before degrading on an ordinary overload',
    (model) => {
      const recovery = new OverloadThinkingRecovery();
      const body = request(model, { includeThoughts: true, thinkingLevel: 'LOW' });
      const promoted = recovery.admit(capacity, body);
      expect(promoted).toMatchObject({
        kind: 'promote_capacity',
        body: {
          model: 'gemini-3.8-flash-high',
          request: { generationConfig: { thinkingConfig: { thinkingLevel: 'HIGH' } } },
        },
      });
      expect(recovery.admit(capacity, body)).toBeUndefined();
      expect(recovery.admit(overload, promoted!.body)).toMatchObject({
        kind: 'degrade_thinking',
        body: { model: 'gemini-3.8-flash-medium' },
      });
      expect(recovery.admit(overload, body)).toBeUndefined();
    },
  );

  it.each([408, 500, 502, 503, 504, 529])('accepts explicit overload at status %s', (status) => {
    const error = new UpstreamRequestError({ status, message: 'The model is overloaded.' });
    expect(new OverloadThinkingRecovery().admit(error, request())).toBeDefined();
  });

  it.each([
    new Error('The model is overloaded.'),
    new UpstreamRequestError({ status: 504, message: 'Service unavailable' }),
    new UpstreamRequestError({ status: 400, message: 'The model is overloaded.' }),
    new UpstreamRequestError({ status: 429, message: 'The model is overloaded.' }),
    new UpstreamRequestError({ status: 503, message: 'QUOTA_EXHAUSTED overloaded' }),
    new UpstreamRequestError({ status: 503, message: 'RESOURCE_EXHAUSTED' }),
  ])('leaves unclassified, quota and rate errors to existing handling', (error) => {
    expect(new OverloadThinkingRecovery().admit(error, request())).toBeUndefined();
  });

  it('limits structured overload evidence on other statuses to the provider domain', () => {
    const error = (domain: string) =>
      new UpstreamRequestError({
        status: 500,
        message: 'Unavailable',
        details: [
          { type: 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'MODEL_OVERLOADED', domain },
        ],
      });
    expect(
      new OverloadThinkingRecovery().admit(error('cloudcode-pa.googleapis.com'), request()),
    ).toBeDefined();
    expect(
      new OverloadThinkingRecovery().admit(error('untrusted.invalid'), request()),
    ).toBeUndefined();
  });

  it('preserves image requests, model-owned caches and short output allowances', () => {
    const recovery = new OverloadThinkingRecovery();
    const image = request('gemini-3.8-flash-image');
    expect(recovery.admit(overload, image)).toBeUndefined();
    const cached = request('gemini-3.8-flash-high');
    cached.request.cachedContent = 'cachedContents/synthetic';
    expect(recovery.admit(overload, cached)).toBeUndefined();
    const short = request();
    short.request.generationConfig = {
      maxOutputTokens: 5023,
      thinkingConfig: { includeThoughts: true, thinkingBudget: -1 },
    };
    expect(recovery.admit(overload, short)).toBeUndefined();
    short.request.generationConfig.maxOutputTokens = 5024;
    expect(recovery.admit(overload, short)?.body.request.generationConfig).toEqual({
      maxOutputTokens: 5024,
      thinkingConfig: { includeThoughts: true, thinkingBudget: 4000 },
    });
  });

  it('refuses an expired original deadline and a revoked account lease', () => {
    const recovery = new OverloadThinkingRecovery();
    expect(() =>
      recovery.admit(overload, request(), undefined, () => true, performance.now() - 1),
    ).toThrow(GenerationDeadlineExceededError);
    expect(recovery.admit(overload, request(), undefined, () => false)).toBeUndefined();
    expect(recovery.admit(overload, request(), undefined, () => true)).toBeDefined();
  });

  it('preserves caller cancellation', () => {
    const controller = new AbortController();
    controller.abort(new Error('controlled cancellation'));
    expect(() =>
      new OverloadThinkingRecovery().admit(overload, request(), controller.signal),
    ).toThrow(new DOMException('Upstream request cancelled', 'AbortError'));
  });
});
