import { performance } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';
import type { GeminiInternalRequest } from '@/modules/proxy-gateway/antigravity/types';
import { UpstreamRequestError } from '@/modules/proxy-gateway/server/common/exceptions/upstream-request.exception';
import { GenerationDeadlineExceededError } from '@/modules/proxy-gateway/server/common/exceptions/generation-deadline.exception';
import {
  createOverloadThinkingRecovery,
  OverloadThinkingRecovery,
} from '@/modules/proxy-gateway/server/common/overload-thinking-recovery';

function request(): GeminiInternalRequest {
  return {
    model: 'gemini-3-flash',
    project: 'synthetic-project',
    requestId: 'synthetic-request',
    userAgent: 'synthetic-agent',
    requestType: 'generate-content',
    request: {
      contents: [{ role: 'user', parts: [{ text: 'Explain the fixture.' }] }],
      generationConfig: {
        temperature: 0.3,
        maxOutputTokens: 8192,
        thinkingConfig: { includeThoughts: true, thinkingBudget: -1 },
      },
    },
  };
}

function overloaded(status = 503) {
  return new UpstreamRequestError({ status, message: 'The model is overloaded.' });
}

describe('automatic thinking overload recovery admission', () => {
  it('recognizes automatic bare families while preserving explicitly named recipes', () => {
    const options = {
      model: 'gemini-3-flash',
      explicitThinking: false,
      physicalTarget: false,
      registeredBudget: 10000,
    };
    expect(createOverloadThinkingRecovery(options).admit(overloaded(), request())).toBeDefined();
    expect(
      createOverloadThinkingRecovery({ ...options, model: 'models/gemini-3-flash' }).admit(
        overloaded(),
        request(),
      ),
    ).toBeDefined();
    for (const changed of [
      { model: 'gemini-3-flash-high' },
      { model: 'gemini-pro-agent' },
      { explicitThinking: true },
      { physicalTarget: true },
    ]) {
      expect(
        createOverloadThinkingRecovery({ ...options, ...changed }).admit(overloaded(), request()),
      ).toBeUndefined();
    }
  });
  it('changes only the adaptive budget and consumes one request-local allowance', () => {
    const body = request();
    const before = structuredClone(body);
    const recovery = new OverloadThinkingRecovery(true);
    const reduced = recovery.admit(overloaded(), body, undefined, () => true);

    expect(reduced).toEqual({
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
    expect(reduced).not.toBe(body);
    expect(reduced?.request).not.toBe(body.request);
    expect(recovery.admit(overloaded(), body)).toBeUndefined();
    expect(new OverloadThinkingRecovery(true).admit(overloaded(), body)).toEqual(reduced);
  });

  it.each([408, 500, 502, 503, 504, 529])('accepts explicit overload at status %s', (status) => {
    expect(new OverloadThinkingRecovery(true).admit(overloaded(status), request())).toBeDefined();
  });

  it.each([
    new Error('The model is overloaded.'),
    new UpstreamRequestError({ status: 503, message: 'Service unavailable' }),
    new UpstreamRequestError({ status: 529, message: 'Temporary failure' }),
    new UpstreamRequestError({ status: 400, message: 'The model is overloaded.' }),
    new UpstreamRequestError({ status: 429, message: 'The model is overloaded.' }),
    new UpstreamRequestError({ status: 503, message: 'MODEL_CAPACITY_EXHAUSTED overloaded' }),
    new UpstreamRequestError({ status: 503, message: 'QUOTA_EXHAUSTED overloaded' }),
  ])('rejects a status or diagnostic that does not authorize degradation', (error) => {
    expect(new OverloadThinkingRecovery(true).admit(error, request())).toBeUndefined();
  });

  it('uses trusted structured overload evidence without relying on the rendered message', () => {
    const detail = {
      type: 'type.googleapis.com/google.rpc.ErrorInfo',
      reason: 'MODEL_OVERLOADED',
      domain: 'cloudcode-pa.googleapis.com',
    };
    const error = (domain: string) =>
      new UpstreamRequestError({
        status: 503,
        message: 'Unavailable',
        details: [{ ...detail, domain }],
      });
    expect(new OverloadThinkingRecovery(true).admit(error(detail.domain), request())).toBeDefined();
    expect(
      new OverloadThinkingRecovery(true).admit(error('untrusted.invalid'), request()),
    ).toBeUndefined();
  });

  it('requires original request eligibility and a final adaptive budget', () => {
    expect(new OverloadThinkingRecovery(false).admit(overloaded(), request())).toBeUndefined();
    for (const budget of [0, 1000, 4000, 10001]) {
      const body = request();
      body.request.generationConfig = {
        maxOutputTokens: 16384,
        thinkingConfig: { includeThoughts: true, thinkingBudget: budget },
      };
      expect(new OverloadThinkingRecovery(true).admit(overloaded(), body)).toBeUndefined();
    }
    const level = request();
    level.request.generationConfig = {
      maxOutputTokens: 16384,
      thinkingConfig: { includeThoughts: true, thinkingBudget: -1, thinkingLevel: 'HIGH' },
    };
    expect(new OverloadThinkingRecovery(true).admit(overloaded(), level)).toBeUndefined();
  });

  it('preserves output allowance and refuses to consume its required output reserve', () => {
    for (const maxOutputTokens of [1, 1024, 4000, 5023]) {
      const body = request();
      body.request.generationConfig = {
        maxOutputTokens,
        thinkingConfig: { includeThoughts: true, thinkingBudget: -1 },
      };
      expect(new OverloadThinkingRecovery(true).admit(overloaded(), body)).toBeUndefined();
    }
    const body = request();
    body.request.generationConfig = {
      maxOutputTokens: 5024,
      thinkingConfig: { includeThoughts: false, thinkingBudget: -1 },
    };
    expect(
      new OverloadThinkingRecovery(true).admit(overloaded(), body)?.request.generationConfig,
    ).toEqual({
      maxOutputTokens: 5024,
      thinkingConfig: { includeThoughts: false, thinkingBudget: 4000 },
    });
  });

  it('refuses an expired original deadline and a revoked account lease', () => {
    const recovery = new OverloadThinkingRecovery(true);
    expect(() =>
      recovery.admit(overloaded(), request(), undefined, () => true, performance.now() - 1),
    ).toThrow(GenerationDeadlineExceededError);
    expect(recovery.admit(overloaded(), request(), undefined, () => false)).toBeUndefined();
    expect(recovery.admit(overloaded(), request(), undefined, () => true)).toBeDefined();
  });

  it('preserves caller cancellation without sending a reduced request', () => {
    const controller = new AbortController();
    const reason = new Error('controlled cancellation');
    controller.abort(reason);
    expect(() =>
      new OverloadThinkingRecovery(true).admit(overloaded(), request(), controller.signal),
    ).toThrow(new DOMException('Upstream request cancelled', 'AbortError'));
  });
});
