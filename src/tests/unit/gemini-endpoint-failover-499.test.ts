import { describe, expect, it } from 'vitest';
import { AxiosError, AxiosHeaders } from 'axios';
import { GeminiClient } from '@/server/gateway/modules/gemini/gemini-client.service';

/**
 * `shouldFailoverToNextEndpoint` decides whether a failed call is worth retrying against the
 * next internal endpoint. Quota and cancellation belong to the account/request lifecycle;
 * endpoint failover is reserved for endpoint availability and transport failures.
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
  it('keeps 499 with the account/request lifecycle', () => {
    expect(shouldFailover(499)).toBe(false);
  });

  it('fails over on endpoint availability and transient server failures', () => {
    expect(shouldFailover(404)).toBe(true);
    expect(shouldFailover(408)).toBe(true);
    expect(shouldFailover(503)).toBe(true);
  });

  it('keeps every 429 quota result with the account/request lifecycle', () => {
    const client = Object.create(GeminiClient.prototype) as GeminiClient;
    const error = makeAxiosError(429);
    error.response!.data = {
      error: { details: [{ reason: 'QUOTA_EXHAUSTED', metadata: { quotaResetDelay: '520035s' } }] },
    };
    expect(Reflect.get(client, 'shouldFailoverToNextEndpoint').call(client, error)).toBe(false);
    error.response!.data = {
      error: { status: 'RESOURCE_EXHAUSTED', details: [{ retryDelay: '520035s' }] },
    };
    expect(Reflect.get(client, 'shouldFailoverToNextEndpoint').call(client, error)).toBe(false);
  });

  it('still fails fast on permanent auth rejections', () => {
    expect(shouldFailover(401)).toBe(false);
    expect(shouldFailover(403)).toBe(false);
  });

  it('does not fail over on an ordinary client error', () => {
    expect(shouldFailover(400)).toBe(false);
  });
});
