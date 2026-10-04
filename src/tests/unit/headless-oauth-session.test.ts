import http from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GoogleAPIService } from '@/modules/cloud-account/services/GoogleAPIService';
import { HeadlessOAuthSessionService } from '@/modules/cloud-account/services/headless-oauth-session.service';
import type { CloudAccount } from '@/modules/cloud-account/types';

const services: HeadlessOAuthSessionService[] = [];

async function request(
  url: string,
  method: 'GET' | 'POST' = 'GET',
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http
      .request(url, { method }, (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () =>
          resolve({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      })
      .once('error', reject)
      .end();
  });
}

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.stop()));
  vi.restoreAllMocks();
});

function createService(timeoutMs?: number) {
  vi.spyOn(GoogleAPIService, 'getActiveOAuthClientKey').mockReturnValue('test-client');
  vi.spyOn(GoogleAPIService, 'getAuthUrl').mockImplementation((_key, session) => {
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.searchParams.set('redirect_uri', session?.redirectUri ?? '');
    url.searchParams.set('state', session?.state ?? '');
    return url.toString();
  });
  const enroll = vi.fn(
    async () =>
      ({
        id: '11111111-1111-4111-8111-111111111111',
        email: 'example@example.com',
      }) as CloudAccount,
  );
  const reload = vi.fn(async () => true);
  const service = new HeadlessOAuthSessionService(enroll, reload, timeoutMs);
  services.push(service);
  return { service, enroll, reload };
}

describe('headless OAuth session', () => {
  it('accepts a pasted code once and uses the same client and redirect as the browser session', async () => {
    const { service, enroll } = createService();
    const started = await service.start('manual-client');
    const redirect = new URL(started.authorizationUrl).searchParams.get('redirect_uri');

    expect(service.completeCode(started.sessionId, '4/manual-code')).toBe(true);
    expect(service.completeCode(started.sessionId, '4/replayed-code')).toBe(false);
    await vi.waitFor(() => expect(service.status(started.sessionId)?.state).toBe('succeeded'));
    expect(enroll).toHaveBeenCalledExactlyOnceWith('4/manual-code', {
      oauthClientKey: 'manual-client',
      redirectUri: redirect,
    });
    expect(service.completeCode(started.sessionId, '4/late-code')).toBe(false);
    await expect(request(`${redirect}?code=4/late-code&state=wrong`)).rejects.toThrow();
  });

  it('lets only the first of callback and manual submission enroll the account', async () => {
    const { service, enroll } = createService();
    const started = await service.start();
    const authorization = new URL(started.authorizationUrl);
    const redirect = authorization.searchParams.get('redirect_uri');
    const state = authorization.searchParams.get('state');

    expect((await request(`${redirect}?code=callback-code&state=${state}`)).status).toBe(200);
    expect(service.completeCode(started.sessionId, 'manual-code')).toBe(false);
    await vi.waitFor(() => expect(service.status(started.sessionId)?.state).toBe('succeeded'));
    expect(enroll).toHaveBeenCalledExactlyOnceWith('callback-code', {
      oauthClientKey: 'test-client',
      redirectUri: redirect,
    });
  });

  it('binds loopback, rejects mismatched state, and consumes a valid code once', async () => {
    const { service, enroll, reload } = createService();
    const started = await service.start();
    const authorization = new URL(started.authorizationUrl);
    const callback = authorization.searchParams.get('redirect_uri');
    const state = authorization.searchParams.get('state');
    expect(callback).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/oauth-callback$/);
    expect(state).toBeTruthy();
    expect(service.status(started.sessionId)).toEqual({ state: 'pending' });

    const wrongMethod = await request(`${callback}?code=wrong&state=${state}`, 'POST');
    expect(wrongMethod.status).toBe(405);
    expect(enroll).not.toHaveBeenCalled();

    const wrong = await request(`${callback}?code=wrong&state=invalid`);
    expect(wrong.status).toBe(400);
    expect(enroll).not.toHaveBeenCalled();
    expect(service.status(started.sessionId)).toEqual({ state: 'pending' });

    const accepted = await request(`${callback}?code=secret-code&state=${state}`);
    expect(accepted.status).toBe(200);
    expect(accepted.body).not.toContain('secret-code');
    await vi.waitFor(() => {
      expect(service.status(started.sessionId)).toEqual({
        state: 'succeeded',
        account: { id: '11111111-1111-4111-8111-111111111111', email: 'example@example.com' },
      });
    });
    expect(enroll).toHaveBeenCalledExactlyOnceWith('secret-code', {
      oauthClientKey: 'test-client',
      redirectUri: callback,
    });
    expect(reload).toHaveBeenCalledOnce();
    expect(GoogleAPIService.getAuthUrl).toHaveBeenCalledWith('test-client', {
      redirectUri: callback,
      state,
    });
    await expect(request(`${callback}?code=another&state=${state}`)).rejects.toThrow();
  });

  it('uses an explicit client key even when the active preference changes', async () => {
    const { service, enroll } = createService();
    const started = await service.start('explicit-client');
    const url = new URL(started.authorizationUrl);
    const callbackUrl = url.searchParams.get('redirect_uri');
    const state = url.searchParams.get('state');

    vi.mocked(GoogleAPIService.getActiveOAuthClientKey).mockReturnValue('new-active-client');
    expect((await request(`${callbackUrl}?code=private-code&state=${state}`)).status).toBe(200);
    await vi.waitFor(() => expect(service.status(started.sessionId)?.state).toBe('succeeded'));
    expect(GoogleAPIService.getAuthUrl).toHaveBeenCalledWith('explicit-client', {
      redirectUri: callbackUrl,
      state,
    });
    expect(enroll).toHaveBeenCalledWith('private-code', {
      oauthClientKey: 'explicit-client',
      redirectUri: callbackUrl,
    });
  });

  it('cancels only the requested pending listener and leaves admitted enrollment intact', async () => {
    const { service, enroll } = createService();
    const first = await service.start();
    const firstUrl = new URL(first.authorizationUrl);
    const firstCallback = firstUrl.searchParams.get('redirect_uri');
    await service.cancel('22222222-2222-4222-8222-222222222222');
    expect(service.status(first.sessionId)).toEqual({ state: 'pending' });
    await service.cancel(first.sessionId);
    await service.cancel(first.sessionId);
    expect(service.status(first.sessionId)).toEqual({
      state: 'failed',
      message: 'OAuth login was cancelled',
    });
    await expect(request(`${firstCallback}?code=late&state=late`)).rejects.toThrow();

    const second = await service.start();
    const secondUrl = new URL(second.authorizationUrl);
    const secondCallback = secondUrl.searchParams.get('redirect_uri');
    const state = secondUrl.searchParams.get('state');
    expect((await request(`${secondCallback}?code=accepted&state=${state}`)).status).toBe(200);
    await vi.waitFor(() => expect(enroll).toHaveBeenCalledOnce());
    await service.cancel(second.sessionId);
    await vi.waitFor(() => expect(service.status(second.sessionId)?.state).toBe('succeeded'));
  });

  it('does not interrupt an enrollment already admitted before cancellation', async () => {
    vi.spyOn(GoogleAPIService, 'getActiveOAuthClientKey').mockReturnValue('test-client');
    vi.spyOn(GoogleAPIService, 'getAuthUrl').mockImplementation((_key, session) => {
      const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
      url.searchParams.set('redirect_uri', session.redirectUri);
      url.searchParams.set('state', session.state);
      return url.toString();
    });
    let finishEnrollment!: (account: CloudAccount) => void;
    const enrollment = new Promise<CloudAccount>((resolve) => {
      finishEnrollment = resolve;
    });
    const enroll = vi.fn(async () => enrollment);
    const session = new HeadlessOAuthSessionService(enroll);
    services.push(session);
    const started = await session.start();
    const url = new URL(started.authorizationUrl);
    const callbackUrl = url.searchParams.get('redirect_uri');
    const state = url.searchParams.get('state');

    expect((await request(`${callbackUrl}?code=private-code&state=${state}`)).status).toBe(200);
    await vi.waitFor(() => expect(enroll).toHaveBeenCalledOnce());
    await session.cancel(started.sessionId);
    expect(session.status(started.sessionId)).toEqual({ state: 'pending' });
    finishEnrollment({
      id: '11111111-1111-4111-8111-111111111111',
      email: 'example@example.com',
    } as CloudAccount);
    await vi.waitFor(() => expect(session.status(started.sessionId)?.state).toBe('succeeded'));
  });

  it('reports denial without invoking enrollment and permits a later login', async () => {
    const { service, enroll } = createService();
    const first = await service.start();
    const url = new URL(first.authorizationUrl);
    const callback = url.searchParams.get('redirect_uri');
    const state = url.searchParams.get('state');
    expect((await request(`${callback}?error=access_denied&state=${state}`)).status).toBe(400);
    await vi.waitFor(() =>
      expect(service.status(first.sessionId)).toEqual({
        state: 'failed',
        message: 'Google authorization was denied',
      }),
    );
    expect(enroll).not.toHaveBeenCalled();
    const second = await service.start();
    expect(second.sessionId).not.toBe(first.sessionId);
    expect(service.status(first.sessionId)).toEqual({
      state: 'failed',
      message: 'Google authorization was denied',
    });
  });

  it('expires a pending session and closes its callback listener', async () => {
    const { service, enroll } = createService(20);
    const started = await service.start();
    const callback = new URL(started.authorizationUrl).searchParams.get('redirect_uri');
    await vi.waitFor(() =>
      expect(service.status(started.sessionId)).toEqual({
        state: 'failed',
        message: 'OAuth login timed out',
      }),
    );
    expect(enroll).not.toHaveBeenCalled();
    await expect(request(`${callback}?code=late&state=late`)).rejects.toThrow();
  });

  it.each([false, 'throw'] as const)(
    'keeps a persisted account successful when gateway cache refresh is %s',
    async (outcome) => {
      const { service, reload } = createService();
      if (outcome === 'throw') {
        reload.mockRejectedValue(new Error('upstream detail must stay private'));
      } else {
        reload.mockResolvedValue(false);
      }
      const started = await service.start();
      const authorization = new URL(started.authorizationUrl);
      const callback = authorization.searchParams.get('redirect_uri');
      const state = authorization.searchParams.get('state');

      expect((await request(`${callback}?code=secret-code&state=${state}`)).status).toBe(200);
      await vi.waitFor(() =>
        expect(service.status(started.sessionId)).toEqual({
          state: 'succeeded',
          account: {
            id: '11111111-1111-4111-8111-111111111111',
            email: 'example@example.com',
          },
        }),
      );
      expect(reload).toHaveBeenCalledOnce();
    },
  );

  it('rejects starts once shutdown begins, including an in-flight start', async () => {
    const { service } = createService();
    const starting = service.start();
    const shutdown = service.stop();

    await expect(starting).rejects.toThrow('unavailable during shutdown');
    await shutdown;
    await expect(service.start()).rejects.toThrow('unavailable during shutdown');
    expect(GoogleAPIService.getAuthUrl).not.toHaveBeenCalled();
  });

  it('does not create another callback listener after stopping an active session', async () => {
    const { service } = createService();
    const started = await service.start();
    const callback = new URL(started.authorizationUrl).searchParams.get('redirect_uri');
    const shutdown = service.stop();

    await expect(service.start()).rejects.toThrow('unavailable during shutdown');
    await shutdown;
    expect(service.status(started.sessionId)).toEqual({
      state: 'failed',
      message: 'OAuth login was cancelled',
    });
    await expect(request(`${callback}?code=late&state=late`)).rejects.toThrow();
  });
});
