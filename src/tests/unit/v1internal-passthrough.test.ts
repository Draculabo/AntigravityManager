import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import { V1InternalPassthroughController } from '@/modules/proxy-gateway/server/modules/v1internal-passthrough/v1internal-passthrough.controller';
import { V1InternalPassthroughService } from '@/modules/proxy-gateway/server/modules/v1internal-passthrough/v1internal-passthrough.service';

/**
 * The gated diagnostic that lets an operator measure what a vendor verb actually answers,
 * instead of reading a mapper's compatibility rendering of it. Claims about the upstream
 * envelope are otherwise unfalsifiable from inside this codebase.
 */

function createReply() {
  const reply: Record<string, unknown> & {
    body?: unknown;
    headers: Record<string, unknown>;
    statusCode?: number;
  } = { headers: {} };
  reply.header = vi.fn((name: string, value: unknown) => {
    reply.headers[name] = value;
    return reply;
  });
  reply.status = vi.fn((code: number) => {
    reply.statusCode = code;
    return reply;
  });
  reply.send = vi.fn((payload: unknown) => {
    reply.body = payload;
    return reply;
  });
  return reply;
}

function createService(overrides: {
  account?: { email: string; id: string; token: Record<string, unknown> } | null;
  upstream?: { body: string; headers: Record<string, string>; status: number };
}) {
  const accountLeaseService = {
    getNextToken: vi.fn(async () =>
      overrides.account === undefined
        ? {
            email: 'probe@example.com',
            id: 'acc-probe',
            token: { access_token: 'access-acc-probe', upstream_proxy_url: undefined },
          }
        : overrides.account,
    ),
  };
  const geminiClient = {
    postV1InternalRaw: vi.fn(
      async () =>
        overrides.upstream ?? {
          body: '{"response":{"candidates":[]}}',
          headers: { 'content-type': 'application/json' },
          status: 200,
        },
    ),
  };

  return {
    accountLeaseService,
    geminiClient,
    service: new V1InternalPassthroughService(accountLeaseService as never, geminiClient as never),
  };
}

describe('v1internal diagnostic passthrough', () => {
  it('registers no route unless it was enabled at startup', async () => {
    const module =
      await import('@/modules/proxy-gateway/server/modules/v1internal-passthrough/v1internal-passthrough.module');

    // The suite runs without AGM_V1INTERNAL_PASSTHROUGH, which is the default posture.
    expect(process.env.AGM_V1INTERNAL_PASSTHROUGH).not.toBe('1');
    expect(module.getV1InternalPassthroughControllers()).toEqual([]);
  });

  it('hands back the upstream status and raw body rather than a parsed rendering', async () => {
    const { service } = createService({
      upstream: {
        body: '{"traceId":"abc","response":{"candidates":[]}}',
        headers: { 'content-type': 'application/json' },
        status: 200,
      },
    });
    const controller = new V1InternalPassthroughController(service);
    const reply = createReply();

    await controller.post('generateChat', { request: {} }, reply as never);

    expect(reply.statusCode).toBe(200);
    expect(reply.body).toBe('{"traceId":"abc","response":{"candidates":[]}}');
  });

  it('names the account whose quota was charged', async () => {
    const { service } = createService({});
    const controller = new V1InternalPassthroughController(service);
    const reply = createReply();

    await controller.post('generateChat', {}, reply as never);

    expect(reply.headers['x-antigravity-v1internal-account-id']).toBe('acc-probe');
    expect(reply.headers['x-antigravity-v1internal-account-email']).toBe('probe@example.com');
  });

  it('forwards the body and the leased credentials to the authorised transport', async () => {
    const { geminiClient, service } = createService({});
    const controller = new V1InternalPassthroughController(service);
    const body = { request: { model: 'gemini-3-flash' } };

    await controller.post('countTokens', body, createReply() as never);

    expect(geminiClient.postV1InternalRaw).toHaveBeenCalledWith(
      'countTokens',
      body,
      'access-acc-probe',
      undefined,
    );
  });

  it('keeps an upstream rejection intact instead of turning it into a local error', async () => {
    const { service } = createService({
      upstream: {
        body: '{"error":{"code":400,"status":"INVALID_ARGUMENT"}}',
        headers: { 'content-type': 'application/json' },
        status: 400,
      },
    });
    const controller = new V1InternalPassthroughController(service);
    const reply = createReply();

    await controller.post('embedContent', {}, reply as never);

    expect(reply.statusCode).toBe(400);
    expect(reply.body).toBe('{"error":{"code":400,"status":"INVALID_ARGUMENT"}}');
  });

  it('reflects only the correlation headers, not whatever else upstream set', async () => {
    const { service } = createService({
      upstream: {
        body: '{}',
        headers: {
          'content-type': 'application/json',
          'set-cookie': 'session=secret',
          'x-goog-request-id': 'req-42',
        },
        status: 200,
      },
    });
    const controller = new V1InternalPassthroughController(service);
    const reply = createReply();

    await controller.post('generateChat', {}, reply as never);

    expect(reply.headers['x-goog-request-id']).toBe('req-42');
    expect(reply.headers['content-type']).toBe('application/json');
    expect(reply.headers['set-cookie']).toBeUndefined();
  });

  it('refuses a verb that is not a plain method name', async () => {
    const { geminiClient, service } = createService({});
    const controller = new V1InternalPassthroughController(service);

    await expect(controller.post('../secrets', {}, createReply() as never)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(geminiClient.postV1InternalRaw).not.toHaveBeenCalled();
  });

  it('says so when no account is eligible instead of probing without one', async () => {
    const { geminiClient, service } = createService({ account: null });
    const controller = new V1InternalPassthroughController(service);

    await expect(
      controller.post('generateChat', {}, createReply() as never),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(geminiClient.postV1InternalRaw).not.toHaveBeenCalled();
  });
});
