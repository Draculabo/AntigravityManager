import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ManagementClient } from '@/core/management/client';
import { ManagementServer } from '@/core/management/server';
import { StandaloneCoreOAuthLogin } from '@/modules/cloud-account/ipc/standalone-core-oauth-login';
import { GoogleAPIService } from '@/modules/cloud-account/services/GoogleAPIService';
import { HeadlessOAuthSessionService } from '@/modules/cloud-account/services/headless-oauth-session.service';
import type { CloudAccountView } from '@/modules/cloud-account/services/cloud-account-view';
import type { CloudAccount } from '@/modules/cloud-account/types';

vi.mock('electron', () => ({ shell: { openExternal: vi.fn() } }));

const closeables: Array<{ close(): Promise<void> }> = [];
const sessions: HeadlessOAuthSessionService[] = [];
const directories: string[] = [];
const view: CloudAccountView = {
  id: '11111111-1111-4111-8111-111111111111',
  provider: 'google',
  email: 'example@example.com',
  created_at: 1,
  last_used: 1,
  proxy_configured: false,
};

async function endpoint(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agm-remote-oauth-'));
  directories.push(directory);
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\agm-remote-oauth-${path.basename(directory)}`
    : path.join(directory, 'core.sock');
}

async function callback(url: string): Promise<number> {
  return new Promise((resolve, reject) => {
    http
      .get(url, (response) => {
        response.resume();
        response.once('end', () => resolve(response.statusCode ?? 0));
      })
      .once('error', reject);
  });
}

afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.stop()));
  await Promise.all(closeables.splice(0).map((server) => server.close()));
  await Promise.all(
    directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
  vi.restoreAllMocks();
});

describe('remote desktop OAuth login', () => {
  it('forwards a pasted code to the core owner and returns the account view', async () => {
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
    const socketPath = await endpoint();
    const server = new ManagementServer({
      endpoint: socketPath,
      getStatus: () => ({ state: 'running', pid: 123, gateway: { running: false, port: null } }),
      shutdown: async () => {},
      onShutdownError: vi.fn(),
      oauth: session,
    });
    closeables.push(server);
    await server.start();

    const openExternal = vi.fn(async (_url: string) => {});
    const login = new StandaloneCoreOAuthLogin({
      management: new ManagementClient(socketPath),
      setPreference: vi.fn(async () => {}),
      accountViews: vi.fn(async () => [view]),
      openExternal,
    });
    const pending = login.start();
    await vi.waitFor(() => expect(openExternal).toHaveBeenCalledOnce());
    const redirect = new URL(openExternal.mock.calls[0][0]).searchParams.get('redirect_uri');
    await login.submitCode('4/manual-code');
    expect(await pending).toEqual(view);
    expect(enroll).toHaveBeenCalledExactlyOnceWith('4/manual-code', {
      oauthClientKey: 'client-a',
      redirectUri: redirect,
    });
    await expect(login.submitCode('4/replay')).rejects.toMatchObject({ loginCode: 'login-failed' });
  }, 15_000);

  it('uses the core owner over a real private endpoint and returns only its strict view', async () => {
    vi.spyOn(GoogleAPIService, 'getActiveOAuthClientKey').mockReturnValue('active-client');
    vi.spyOn(GoogleAPIService, 'getAuthUrl').mockImplementation((_key, session) => {
      const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
      url.searchParams.set('redirect_uri', session.redirectUri);
      url.searchParams.set('state', session.state);
      return url.toString();
    });
    const enroll = vi.fn(async () => ({ id: view.id, email: view.email }) as CloudAccount);
    const session = new HeadlessOAuthSessionService(enroll);
    sessions.push(session);
    const socketPath = await endpoint();
    const server = new ManagementServer({
      endpoint: socketPath,
      getStatus: () => ({ state: 'running', pid: 123, gateway: { running: false, port: null } }),
      shutdown: async () => {},
      onShutdownError: vi.fn(),
      oauth: session,
    });
    closeables.push(server);
    await server.start();

    const openExternal = vi.fn(async (_url: string) => {});
    const setPreference = vi.fn(async (_key: string) => {});
    const accountViews = vi.fn(async () => [view]);
    const login = new StandaloneCoreOAuthLogin({
      management: new ManagementClient(socketPath),
      setPreference,
      accountViews,
      openExternal,
    });
    const pending = login.start('explicit-client');
    await vi.waitFor(() => expect(openExternal).toHaveBeenCalledOnce());
    const url = new URL(openExternal.mock.calls[0][0]);
    const redirect = url.searchParams.get('redirect_uri');
    const state = url.searchParams.get('state');
    expect(setPreference).toHaveBeenCalledExactlyOnceWith('explicit-client');
    expect(url.hostname).toBe('accounts.google.com');
    expect(await callback(`${redirect}?code=bad&state=wrong`)).toBe(400);
    expect(enroll).not.toHaveBeenCalled();

    vi.mocked(GoogleAPIService.getActiveOAuthClientKey).mockReturnValue('changed-active');
    expect(await callback(`${redirect}?code=private-code&state=${state}`)).toBe(200);
    expect(await pending).toEqual(view);
    expect(enroll).toHaveBeenCalledExactlyOnceWith('private-code', {
      oauthClientKey: 'explicit-client',
      redirectUri: redirect,
    });
    expect(accountViews).toHaveBeenCalledOnce();
    expect(JSON.stringify(await pending)).not.toMatch(/private-code|refresh_token|sessionId|state/);
  }, 15_000);

  it.each([
    ['https://evil.example/private-code', 'login-failed'],
    ['https://accounts.google.com/', 'browser-open-failed'],
  ] as const)('cancels an unsafe or unopened core session', async (authorizationUrl, loginCode) => {
    const management = {
      startOAuth: vi.fn(async () => ({ sessionId: view.id, authorizationUrl })),
      oauthStatus: vi.fn(async () => ({ state: 'pending' as const })),
      cancelOAuth: vi.fn(async () => {}),
      completeOAuth: vi.fn(async () => {}),
    };
    const openExternal = vi.fn(async () => {
      throw new Error('private browser failure');
    });
    const login = new StandaloneCoreOAuthLogin({
      management,
      setPreference: vi.fn(),
      accountViews: vi.fn(),
      openExternal,
    });

    await expect(login.start()).rejects.toMatchObject({ loginCode });
    expect(management.cancelOAuth).toHaveBeenCalledExactlyOnceWith(view.id);
    expect(openExternal).toHaveBeenCalledTimes(
      authorizationUrl.startsWith('https://evil.') ? 0 : 1,
    );
  });

  it('closes a real core callback listener after browser-open failure', async () => {
    vi.spyOn(GoogleAPIService, 'getActiveOAuthClientKey').mockReturnValue('active-client');
    vi.spyOn(GoogleAPIService, 'getAuthUrl').mockImplementation((_key, session) => {
      const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
      url.searchParams.set('redirect_uri', session.redirectUri);
      url.searchParams.set('state', session.state);
      return url.toString();
    });
    const enroll = vi.fn(async () => ({ id: view.id, email: view.email }) as CloudAccount);
    const session = new HeadlessOAuthSessionService(enroll);
    sessions.push(session);
    const socketPath = await endpoint();
    const server = new ManagementServer({
      endpoint: socketPath,
      getStatus: () => ({ state: 'running', pid: 123, gateway: { running: false, port: null } }),
      shutdown: async () => {},
      onShutdownError: vi.fn(),
      oauth: session,
    });
    closeables.push(server);
    await server.start();
    let callbackUrl = '';
    const login = new StandaloneCoreOAuthLogin({
      management: new ManagementClient(socketPath),
      setPreference: vi.fn(),
      accountViews: vi.fn(),
      openExternal: vi.fn(async (url: string) => {
        callbackUrl = new URL(url).searchParams.get('redirect_uri') ?? '';
        throw new Error('private browser error');
      }),
    });

    await expect(login.start()).rejects.toMatchObject({ loginCode: 'browser-open-failed' });
    expect(callbackUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/oauth-callback$/);
    await expect(callback(`${callbackUrl}?code=late&state=late`)).rejects.toThrow();
    expect(enroll).not.toHaveBeenCalled();
  });

  it('closes only its pending core session on desktop shutdown', async () => {
    const management = {
      startOAuth: vi.fn(async () => ({
        sessionId: view.id,
        authorizationUrl: 'https://accounts.google.com/',
      })),
      oauthStatus: vi.fn(async () => ({ state: 'pending' as const })),
      cancelOAuth: vi.fn(async () => {}),
      completeOAuth: vi.fn(async () => {}),
    };
    const openExternal = vi.fn(async () => {});
    const login = new StandaloneCoreOAuthLogin({
      management,
      setPreference: vi.fn(),
      accountViews: vi.fn(),
      openExternal,
    });

    const pending = login.start();
    await vi.waitFor(() => expect(openExternal).toHaveBeenCalledOnce());
    await expect(login.start()).rejects.toMatchObject({ loginCode: 'login-active' });
    await login.stop();
    await expect(pending).rejects.toMatchObject({ loginCode: 'login-cancelled' });
    expect(management.cancelOAuth).toHaveBeenCalledWith(view.id);
    await expect(login.start()).rejects.toMatchObject({ loginCode: 'login-cancelled' });
  });

  it('collapses owner and transport failures to stable renderer categories', async () => {
    const management = {
      startOAuth: vi.fn(async () => ({
        sessionId: view.id,
        authorizationUrl: 'https://accounts.google.com/',
      })),
      oauthStatus: vi.fn(async () => ({
        state: 'failed' as const,
        message: 'private provider token and callback state',
      })),
      cancelOAuth: vi.fn(async () => {}),
      completeOAuth: vi.fn(async () => {}),
    };
    const login = new StandaloneCoreOAuthLogin({
      management,
      setPreference: vi.fn(),
      accountViews: vi.fn(),
      openExternal: vi.fn(async () => {}),
    });
    await expect(login.start()).rejects.toMatchObject({ loginCode: 'login-failed' });
    management.startOAuth.mockRejectedValueOnce(new Error('private pipe failure'));
    await expect(login.start()).rejects.toMatchObject({ loginCode: 'login-failed' });
  });
});
