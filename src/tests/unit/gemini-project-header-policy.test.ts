import axios, { AxiosError, AxiosHeaders } from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_APP_CONFIG } from '@/modules/config/types';
import { setServerConfig } from '@/server/server-config';
import { GeminiClient } from '@/server/gateway/modules/gemini/gemini-client.service';
import { Upstream4xxCaptureService } from '@/server/gateway/common/upstream-4xx-capture.service';

function denial(reason = 'USER_PROJECT_DENIED', consumer = 'projects/project-a') {
  return {
    error: {
      code: 403,
      status: 'PERMISSION_DENIED',
      details: [
        {
          '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
          domain: 'googleapis.com',
          reason,
          metadata: { consumer },
        },
      ],
    },
  };
}

function rejected(data: unknown) {
  return new AxiosError('Request rejected', undefined, undefined, undefined, {
    status: 403,
    statusText: 'Forbidden',
    data,
    headers: {},
    config: { headers: new AxiosHeaders() },
  });
}

describe('Internal quota-project header recovery policy', () => {
  it('carries a matched body-project denial through error sanitization without a transport replay', async () => {
    const post = vi.spyOn(axios, 'post').mockRejectedValue(rejected(denial()));
    vi.stubEnv('PROXY_CONTEXT_CACHE_ENABLED', 'false');
    const client = new GeminiClient(new Upstream4xxCaptureService());
    await expect(
      client.generateInternal(
        {
          project: 'project-a',
          model: 'gemini-3-flash',
          requestId: 'project-fixture',
          userAgent: 'fixture',
          request: {
            contents: [{ role: 'user', parts: [{ text: 'Controlled project request.' }] }],
          },
        },
        'token',
      ),
    ).rejects.toMatchObject({ status: 403, projectConsumerDenied: true });
    expect(post).toHaveBeenCalledOnce();
    expect(post.mock.calls[0]?.[2]?.headers).not.toHaveProperty('x-goog-user-project');
  });
  beforeEach(() => {
    vi.stubEnv(
      'PROXY_INTERNAL_BASE_URLS',
      'http://one.invalid/v1internal,http://two.invalid/v1internal',
    );
    setServerConfig(DEFAULT_APP_CONFIG.proxy);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    setServerConfig(DEFAULT_APP_CONFIG.proxy);
  });

  it.each(['resolved', 'rejected'] as const)(
    'recovers a matching consumer denial once for %s raw HTTP without changing body or token',
    async (mode) => {
      const failure = JSON.stringify(denial());
      const post = vi.spyOn(axios, 'post');
      if (mode === 'resolved') {
        post.mockResolvedValueOnce({ status: 403, headers: {}, data: failure } as never);
      } else {
        post.mockRejectedValueOnce(rejected(failure));
      }
      post.mockResolvedValueOnce({ status: 200, headers: {}, data: '{"ok":true}' } as never);
      const client = new GeminiClient(new Upstream4xxCaptureService());
      const body = { project: 'project-a' };

      await expect(
        client.postV1InternalRaw('loadCodeAssist', body, 'synthetic-token'),
      ).resolves.toMatchObject({ body: '{"ok":true}', status: 200 });

      expect(post.mock.calls.map(([url]) => url)).toEqual([
        'http://one.invalid/v1internal:loadCodeAssist',
        'http://one.invalid/v1internal:loadCodeAssist',
      ]);
      expect(post.mock.calls.map(([, payload]) => payload)).toEqual([
        JSON.stringify(body),
        JSON.stringify(body),
      ]);
      expect(post.mock.calls.map(([, , config]) => config?.headers?.Authorization)).toEqual([
        'Bearer synthetic-token',
        'Bearer synthetic-token',
      ]);
      expect(post.mock.calls[0]?.[2]?.headers?.['x-goog-user-project']).toBe('project-a');
      expect(post.mock.calls[1]?.[2]?.headers).not.toHaveProperty('x-goog-user-project');
    },
  );

  it.each([
    ['plain rejection', { error: 'project permission denied' }],
    ['account permission', denial('IAM_PERMISSION_DENIED')],
    ['other project', denial('USER_PROJECT_DENIED', 'projects/other')],
    ['malformed JSON', '{not json'],
    ['oversized JSON', JSON.stringify({ ...denial(), message: 'x'.repeat(65_536) })],
  ])('does not resend after %s', async (_name, data) => {
    const post = vi
      .spyOn(axios, 'post')
      .mockResolvedValue({ status: 403, headers: {}, data } as never);
    const client = new GeminiClient(new Upstream4xxCaptureService());

    const result = await client.postV1InternalRaw(
      'loadCodeAssist',
      { project: 'project-a' },
      'token',
    );

    expect(result.status).toBe(403);
    expect(post).toHaveBeenCalledOnce();
  });

  it('does not grant header downgrade to an arbitrary diagnostic verb', async () => {
    const post = vi.spyOn(axios, 'post').mockResolvedValue({
      status: 403,
      headers: {},
      data: JSON.stringify(denial()),
    } as never);
    const client = new GeminiClient(new Upstream4xxCaptureService());

    expect(
      (await client.postV1InternalRaw('setPolicy', { project: 'project-a' }, 'token')).status,
    ).toBe(403);
    expect(post).toHaveBeenCalledOnce();
  });

  it('does not downgrade a second time when the no-project request is denied', async () => {
    const post = vi.spyOn(axios, 'post').mockResolvedValue({
      status: 403,
      headers: {},
      data: JSON.stringify(denial()),
    } as never);
    const client = new GeminiClient(new Upstream4xxCaptureService());

    expect(
      (await client.postV1InternalRaw('loadCodeAssist', { project: 'project-a' }, 'token')).status,
    ).toBe(403);
    expect(post).toHaveBeenCalledTimes(2);
  });

  it('removes injected casing of the actual count quota-project header while retaining other headers', async () => {
    const post = vi
      .spyOn(axios, 'post')
      .mockRejectedValueOnce(rejected(denial()))
      .mockResolvedValueOnce({ status: 200, headers: {}, data: { totalTokens: 7 } } as never);
    const client = new GeminiClient(new Upstream4xxCaptureService());

    await expect(
      client.countTokensInternal(
        { request: { contents: [], model: 'models/gemini-3-flash' } },
        'token',
        undefined,
        {
          'X-Goog-User-Project': 'project-a',
          'X-Fixture': 'retained',
        },
      ),
    ).resolves.toEqual({ totalTokens: 7 });

    expect(post).toHaveBeenCalledTimes(2);
    expect(post.mock.calls[1]?.[2]?.headers).toMatchObject({ 'X-Fixture': 'retained' });
    expect(
      Object.keys(post.mock.calls[1]?.[2]?.headers ?? {}).map((name) => name.toLowerCase()),
    ).not.toContain('x-goog-user-project');
  });

  it('refuses downgrade for ambiguous casing with different project values', async () => {
    const post = vi.spyOn(axios, 'post').mockRejectedValue(rejected(denial()));
    const client = new GeminiClient(new Upstream4xxCaptureService());

    await expect(
      client.countTokensInternal(
        { request: { contents: [], model: 'models/gemini-3-flash' } },
        'token',
        undefined,
        {
          'x-goog-user-project': 'project-a',
          'X-Goog-User-Project': 'other-project',
        },
      ),
    ).rejects.toMatchObject({ status: 403 });

    expect(post).toHaveBeenCalledOnce();
  });

  it('keeps a header downgrade across subsequent endpoint transport failover', async () => {
    const post = vi
      .spyOn(axios, 'post')
      .mockResolvedValueOnce({ status: 403, headers: {}, data: JSON.stringify(denial()) } as never)
      .mockRejectedValueOnce(new AxiosError('Connection reset', 'ECONNRESET'))
      .mockResolvedValueOnce({ status: 200, headers: {}, data: '{}' } as never);
    const client = new GeminiClient(new Upstream4xxCaptureService());

    expect(
      (await client.postV1InternalRaw('loadCodeAssist', { project: 'project-a' }, 'token')).status,
    ).toBe(200);

    expect(post.mock.calls.map(([url]) => url)).toEqual([
      'http://one.invalid/v1internal:loadCodeAssist',
      'http://one.invalid/v1internal:loadCodeAssist',
      'http://two.invalid/v1internal:loadCodeAssist',
    ]);
    expect(
      post.mock.calls.slice(1).map(([, , config]) => config?.headers?.['x-goog-user-project']),
    ).toEqual([undefined, undefined]);
    expect(post.mock.calls.map(([, body]) => body)).toEqual([
      '{"project":"project-a"}',
      '{"project":"project-a"}',
      '{"project":"project-a"}',
    ]);
  });
});
