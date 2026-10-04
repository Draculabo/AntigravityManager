import http from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GoogleAPIService } from '@/modules/cloud-account/services/GoogleAPIService';
import { DesktopOAuthLogin } from '@/modules/cloud-account/ipc/desktop-oauth-login';
import { HeadlessOAuthSessionService } from '@/modules/cloud-account/services/headless-oauth-session.service';
import {
  DesktopOAuthLoginError,
  toDesktopOAuthLoginORPCError,
} from '@/modules/cloud-account/services/desktop-oauth-login.error';
import type { CloudAccount } from '@/modules/cloud-account/types';
import type { CloudAccountView } from '@/modules/cloud-account/services/cloud-account-view';

vi.mock('electron', () => ({ shell: { openExternal: vi.fn() } }));

const sessions: HeadlessOAuthSessionService[] = [];
const view: CloudAccountView = {
  id: '11111111-1111-4111-8111-111111111111',
  provider: 'google',
  email: 'example@example.com',
  created_at: 1,
  last_used: 1,
  proxy_configured: false,
};

async function callback(url: string): Promise<number> {
  return new Promise((resolve, reject) => {
    http
      .get(url, (response) => {
        response.resume();
        response.on('end', () => resolve(response.statusCode ?? 0));
      })
      .once('error', reject);
  });
}

afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.stop()));
  vi.restoreAllMocks();
});

describe('desktop owner-side OAuth login', () => {
  it('accepts a manual code while the browser login is pending', async () => {
    vi.spyOn(GoogleAPIService, 'getActiveOAuthClientKey').mockReturnValue('client-a');
    vi.spyOn(GoogleAPIService, 'getAuthUrl').mockImplementation((_key, session) => {
      const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
      url.searchParams.set('redirect_uri', session.redirectUri);
      url.searchParams.set('state', session.state);
      return url.toString();
    });
    const enroll = vi.fn(async () => ({ id: view.id, email: view.email }) as CloudAccount);
    const session = new HeadlessOAuthSessionService(enroll);
    sessions.push(session);
    const openExternal = vi.fn(async (_url: string) => {});
    const login = new DesktopOAuthLogin({
      session,
      selectClient: vi.fn(),
      openExternal,
      loadView: vi.fn(async () => view),
    });

    const pending = login.start();
    await vi.waitFor(() => expect(openExternal).toHaveBeenCalledOnce());
    const redirect = new URL(openExternal.mock.calls[0][0]).searchParams.get('redirect_uri');
    login.submitCode('4/manual-code');
    expect(await pending).toEqual(view);
    expect(enroll).toHaveBeenCalledExactlyOnceWith('4/manual-code', {
      oauthClientKey: 'client-a',
      redirectUri: redirect,
    });
    expect(() => login.submitCode('4/replay')).toThrow();
  });

  it('opens a trusted browser URL, keeps the code owner-side, and returns only the account view', async () => {
    let selected = 'client-a';
    vi.spyOn(GoogleAPIService, 'getActiveOAuthClientKey').mockImplementation(() => selected);
    vi.spyOn(GoogleAPIService, 'getAuthUrl').mockImplementation((_key, session) => {
      const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
      url.searchParams.set('redirect_uri', session.redirectUri);
      url.searchParams.set('state', session.state);
      return url.toString();
    });
    const enroll = vi.fn(async () => ({ id: view.id, email: view.email }) as CloudAccount);
    const reload = vi.fn(async () => true);
    const session = new HeadlessOAuthSessionService(enroll, reload);
    sessions.push(session);
    const openExternal = vi.fn(async (_url: string) => {});
    const login = new DesktopOAuthLogin({
      session,
      selectClient: (key) => {
        selected = key ?? 'client-a';
      },
      openExternal,
      loadView: vi.fn(async () => view),
    });

    const result = login.start('client-b');
    await vi.waitFor(() => expect(openExternal).toHaveBeenCalledOnce());
    const authorization = new URL(openExternal.mock.calls[0][0]);
    const redirect = authorization.searchParams.get('redirect_uri');
    const state = authorization.searchParams.get('state');
    expect(authorization.hostname).toBe('accounts.google.com');
    expect(await callback(`${redirect}?code=wrong&state=incorrect`)).toBe(400);
    expect(enroll).not.toHaveBeenCalled();

    selected = 'client-a';
    expect(await callback(`${redirect}?code=private-code&state=${state}`)).toBe(200);
    expect(await result).toEqual(view);
    expect(enroll).toHaveBeenCalledExactlyOnceWith('private-code', {
      oauthClientKey: 'client-b',
      redirectUri: redirect,
    });
    expect(reload).toHaveBeenCalledOnce();
    expect(JSON.stringify(view)).not.toMatch(/private-code|access_token|refresh_token/);
  });

  it('cancels a pending session if the browser cannot open', async () => {
    const session = {
      start: vi.fn(async () => ({
        sessionId: 's1',
        authorizationUrl: 'https://accounts.google.com/',
      })),
      status: vi.fn(() => ({ state: 'pending' as const })),
      cancel: vi.fn(async () => {}),
      completeCode: vi.fn(() => true),
      stop: vi.fn(async () => {}),
    };
    const login = new DesktopOAuthLogin({
      session,
      selectClient: vi.fn(),
      openExternal: vi.fn(async () => {
        throw new Error('private browser detail');
      }),
      loadView: vi.fn(),
    });

    await expect(login.start()).rejects.toMatchObject({ loginCode: 'browser-open-failed' });
    expect(session.cancel).toHaveBeenCalledExactlyOnceWith('s1');
  });

  it.each([
    ['Google authorization was denied', 'authorization-denied'],
    ['OAuth login timed out', 'login-timeout'],
    ['OAuth login was cancelled', 'login-cancelled'],
    ['Google account already exists', 'duplicate-account'],
    ['private provider details', 'login-failed'],
  ] as const)('maps session failure %s to a value-free code', async (message, loginCode) => {
    const session = {
      start: vi.fn(async () => ({
        sessionId: 's1',
        authorizationUrl: 'https://accounts.google.com/',
      })),
      status: vi.fn(() => ({ state: 'failed' as const, message })),
      cancel: vi.fn(async () => {}),
      completeCode: vi.fn(() => true),
      stop: vi.fn(async () => {}),
    };
    const login = new DesktopOAuthLogin({
      session,
      selectClient: vi.fn(),
      openExternal: vi.fn(async () => {}),
      loadView: vi.fn(),
    });

    await expect(login.start()).rejects.toMatchObject({ loginCode });
  });

  it('stops callback admission and rejects a pending login during shutdown', async () => {
    vi.spyOn(GoogleAPIService, 'getActiveOAuthClientKey').mockReturnValue('client-a');
    vi.spyOn(GoogleAPIService, 'getAuthUrl').mockImplementation((_key, session) => {
      const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
      url.searchParams.set('redirect_uri', session.redirectUri);
      url.searchParams.set('state', session.state);
      return url.toString();
    });
    const enroll = vi.fn(async () => ({ id: view.id, email: view.email }) as CloudAccount);
    const session = new HeadlessOAuthSessionService(enroll);
    sessions.push(session);
    const openExternal = vi.fn(async (_url: string) => {});
    const login = new DesktopOAuthLogin({
      session,
      selectClient: vi.fn(),
      openExternal,
      loadView: vi.fn(async () => view),
    });

    const pending = login.start();
    await vi.waitFor(() => expect(openExternal).toHaveBeenCalledOnce());
    const authorization = new URL(openExternal.mock.calls[0][0]);
    const redirect = authorization.searchParams.get('redirect_uri');
    const state = authorization.searchParams.get('state');
    await expect(login.start()).rejects.toMatchObject({ loginCode: 'login-active' });
    await login.stop();
    await expect(pending).rejects.toMatchObject({ loginCode: 'login-cancelled' });
    await expect(callback(`${redirect}?code=late&state=${state}`)).rejects.toThrow();
    expect(enroll).not.toHaveBeenCalled();
  });

  it('removes raw provider details from the renderer error contract', () => {
    const error = toDesktopOAuthLoginORPCError(new Error('private-code access_token stack'));
    expect(error).toMatchObject({ data: { loginCode: 'login-failed' } });
    expect(JSON.stringify(error)).not.toMatch(/private-code|access_token|stack/);
    expect(new DesktopOAuthLoginError('duplicate-account').message).not.toContain('private');
  });
});
