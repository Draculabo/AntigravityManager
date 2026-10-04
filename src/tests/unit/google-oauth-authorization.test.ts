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
    const { normalizeTrustedGoogleValidationUrl } =
      await import('@/modules/cloud-account/utils/google-validation-url');
    const redirectUri = 'http://127.0.0.1:12345/oauth-callback';
    const state = 'test-session-state';
    const url = new URL(GoogleAPIService.getAuthUrl(clientKey, { redirectUri, state }));
    expect(normalizeTrustedGoogleValidationUrl(url.toString())).toBe(url.toString());

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
      redirect_uri: redirectUri,
      include_granted_scopes: 'true',
      state,
    });
  });
});
