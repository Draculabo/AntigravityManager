import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('Google OAuth authorization scopes', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv(
      'ANTIGRAVITY_OAUTH_CLIENTS',
      'custom_a|id-a|secret-a|Custom A;custom_b|id-b|secret-b|Custom B',
    );
    vi.stubEnv('ANTIGRAVITY_OAUTH_CLIENT_KEY', 'custom_a');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([
    [undefined, 'id-a'],
    ['custom_b', 'id-b'],
  ])('requests OpenID and all existing scopes for client %s', async (clientKey, clientId) => {
    const { GoogleAPIService } = await import('@/modules/cloud-account/services/GoogleAPIService');
    const { AuthServer } = await import('@/modules/cloud-account/ipc/authServer');

    const url = new URL(GoogleAPIService.getAuthUrl(clientKey));

    expect(`${url.origin}${url.pathname}`).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      access_type: 'offline',
      scope: [
        'openid',
        'https://www.googleapis.com/auth/cloud-platform',
        'https://www.googleapis.com/auth/userinfo.email',
        'https://www.googleapis.com/auth/userinfo.profile',
        'https://www.googleapis.com/auth/cclog',
        'https://www.googleapis.com/auth/experimentsandconfigs',
        'https://www.googleapis.com/auth/aicode',
      ].join(' '),
      prompt: 'consent',
      response_type: 'code',
      client_id: clientId,
      redirect_uri: AuthServer.getRedirectUri(),
      include_granted_scopes: 'true',
      state: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      ),
    });
  });
});
