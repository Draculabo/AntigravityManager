import { describe, expect, it } from 'vitest';
import { AxiosError, AxiosHeaders } from 'axios';
import { GeminiClient } from '@/modules/proxy-gateway/server/modules/gemini/gemini-client.service';

/**
 * `shouldFailoverToNextEndpoint` decides whether a failed call is worth retrying against the
 * next internal endpoint. 499 is Google's client-cancelled code and upstream emits it for its
 * own aborts, so treating it as terminal surfaces an upstream hiccup as a request failure.
 */
function makeAxiosError(status: number): AxiosError {
  const error = new AxiosError('upstream said no');
  error.response = {
    status,
    statusText: '',
    data: {},
    headers: new AxiosHeaders(),
    config: { headers: new AxiosHeaders() },
  };
  return error;
}

function shouldFailover(status: number): boolean {
  const client = Object.create(GeminiClient.prototype) as GeminiClient;
  return Reflect.get(client, 'shouldFailoverToNextEndpoint').call(client, makeAxiosError(status));
}

describe('internal endpoint failover', () => {
  it('fails over on 499, the upstream client-cancelled code', () => {
    expect(shouldFailover(499)).toBe(true);
  });

  it('still fails over on the transient statuses it already covered', () => {
    expect(shouldFailover(408)).toBe(true);
    expect(shouldFailover(429)).toBe(true);
    expect(shouldFailover(503)).toBe(true);
  });

  it('does not repeat an explicit long quota failure at another endpoint', () => {
    const client = Object.create(GeminiClient.prototype) as GeminiClient;
    const error = makeAxiosError(429);
    error.response!.data = {
      error: { details: [{ reason: 'QUOTA_EXHAUSTED', metadata: { quotaResetDelay: '520035s' } }] },
    };
    expect(Reflect.get(client, 'shouldFailoverToNextEndpoint').call(client, error)).toBe(false);
    error.response!.data = {
      error: { status: 'RESOURCE_EXHAUSTED', details: [{ retryDelay: '520035s' }] },
    };
    expect(Reflect.get(client, 'shouldFailoverToNextEndpoint').call(client, error)).toBe(true);
  });

  it('still fails fast on permanent auth rejections', () => {
    expect(shouldFailover(401)).toBe(false);
    expect(shouldFailover(403)).toBe(false);
  });

  it('does not fail over on an ordinary client error', () => {
    expect(shouldFailover(400)).toBe(false);
    expect(shouldFailover(404)).toBe(false);
  });
});
