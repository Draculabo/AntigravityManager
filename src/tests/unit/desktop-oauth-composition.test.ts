import http from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { shell } from 'electron';
import { GoogleAPIService } from '@/modules/cloud-account/services/GoogleAPIService';
import { CloudAccountRepo } from '@/modules/cloud-account/persistence/cloudHandler';
import { enrollGoogleAccount } from '@/modules/cloud-account/services/google-account-enrollment.service';
import { notifyTrayUpdate } from '@/modules/cloud-account/ipc/quota-refresh-desktop';
import { reloadNestServerAccountLeaseCache } from '@/server/main';
import { setActiveOAuthClient } from '@/modules/cloud-account/services/cloud-account-oauth-settings.service';
import { desktopOAuthLogin } from '@/modules/cloud-account/ipc/desktop-oauth-login';
import type { CloudAccount } from '@/modules/cloud-account/types';

vi.mock('electron', () => ({ shell: { openExternal: vi.fn() } }));
vi.mock('@/modules/cloud-account/services/google-account-enrollment.service', () => ({
  DuplicateGoogleAccountError: class DuplicateGoogleAccountError extends Error {},
  enrollGoogleAccount: vi.fn(),
}));
vi.mock('@/modules/cloud-account/ipc/quota-refresh-desktop', () => ({
  notifyTrayUpdate: vi.fn(),
}));
vi.mock('@/server/main', () => ({ reloadNestServerAccountLeaseCache: vi.fn(async () => true) }));
vi.mock('@/modules/cloud-account/services/cloud-account-oauth-settings.service', () => ({
  setActiveOAuthClient: vi.fn(),
  hydrateActiveOAuthClientFromSettings: vi.fn(),
}));

const account: CloudAccount = {
  id: '11111111-1111-4111-8111-111111111111',
  provider: 'google',
  email: 'example@example.com',
  token: {
    access_token: 'private-access',
    refresh_token: 'private-refresh',
    expires_in: 3600,
    expiry_timestamp: 3600,
    token_type: 'Bearer',
  },
  quota: { models: {} },
  created_at: 1,
  last_used: 1,
};

afterEach(async () => {
  await desktopOAuthLogin.stop();
  vi.restoreAllMocks();
});

describe('desktop OAuth composition', () => {
  it('enrolls once, refreshes gateway cache, and updates the tray for an account with quota', async () => {
    vi.spyOn(GoogleAPIService, 'getActiveOAuthClientKey').mockReturnValue('client-b');
    vi.spyOn(GoogleAPIService, 'getAuthUrl').mockImplementation((_key, session) => {
      const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
      url.searchParams.set('redirect_uri', session.redirectUri);
      url.searchParams.set('state', session.state);
      return url.toString();
    });
    vi.mocked(enrollGoogleAccount).mockResolvedValue(account);
    vi.spyOn(CloudAccountRepo, 'getAccount').mockResolvedValue(account);
    vi.mocked(shell.openExternal).mockResolvedValue();

    const result = desktopOAuthLogin.start('client-b');
    await vi.waitFor(() => expect(shell.openExternal).toHaveBeenCalledOnce());
    const authorization = new URL(vi.mocked(shell.openExternal).mock.calls[0][0]);
    const redirect = authorization.searchParams.get('redirect_uri');
    const state = authorization.searchParams.get('state');
    const responseStatus = await new Promise<number>((resolve, reject) => {
      http
        .get(`${redirect}?code=private-code&state=${state}`, (response) => {
          response.resume();
          response.on('end', () => resolve(response.statusCode ?? 0));
        })
        .once('error', reject);
    });

    expect(responseStatus).toBe(200);
    expect(await result).toMatchObject({ id: account.id, email: account.email });
    expect(JSON.stringify(await result)).not.toMatch(/private-access|private-refresh|private-code/);
    expect(setActiveOAuthClient).toHaveBeenCalledExactlyOnceWith('client-b');
    expect(enrollGoogleAccount).toHaveBeenCalledOnce();
    expect(notifyTrayUpdate).toHaveBeenCalledExactlyOnceWith(account);
    expect(reloadNestServerAccountLeaseCache).toHaveBeenCalledOnce();
  });
});
