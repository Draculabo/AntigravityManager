import { afterEach, describe, expect, it, vi } from 'vitest';
import { CloudAccountRepo } from '@/modules/cloud-account/persistence/cloudHandler';
import { CloudAccountRefreshService } from '@/modules/cloud-account/services/CloudAccountRefreshService';
import { GoogleAPIService } from '@/modules/cloud-account/services/GoogleAPIService';
import {
  DuplicateGoogleAccountError,
  enrollGoogleAccount,
} from '@/modules/cloud-account/services/google-account-enrollment.service';

afterEach(() => vi.restoreAllMocks());

describe('Google account enrollment', () => {
  it('exchanges with the exact redirect URI and persists the account before quota', async () => {
    const exchange = vi.spyOn(GoogleAPIService, 'exchangeCode').mockResolvedValue({
      access_token: 'access-test',
      refresh_token: 'refresh-test',
      expires_in: 3600,
      token_type: 'Bearer',
      oauth_client_key: 'test',
    });
    vi.spyOn(GoogleAPIService, 'getUserInfo').mockResolvedValue({
      id: 'google-test',
      verified_email: true,
      email: 'example@example.com',
      name: 'Example',
      picture: '',
    });
    vi.spyOn(CloudAccountRepo, 'getAccountByEmail').mockResolvedValue(null);
    const add = vi.spyOn(CloudAccountRepo, 'addAccount').mockResolvedValue(undefined);
    vi.spyOn(CloudAccountRefreshService, 'clearFailureState').mockResolvedValue(undefined);
    vi.spyOn(GoogleAPIService, 'fetchQuota').mockResolvedValue({ models: {} });
    vi.spyOn(GoogleAPIService, 'fetchAICredits').mockResolvedValue(null);
    vi.spyOn(CloudAccountRepo, 'updateQuota').mockResolvedValue(undefined);

    const account = await enrollGoogleAccount('code-test', {
      oauthClientKey: 'test',
      redirectUri: 'http://127.0.0.1:12345/oauth-callback',
    });
    expect(exchange).toHaveBeenCalledExactlyOnceWith(
      'code-test',
      undefined,
      'test',
      'http://127.0.0.1:12345/oauth-callback',
    );
    expect(add).toHaveBeenCalledOnce();
    expect(account).toMatchObject({
      provider: 'google',
      email: 'example@example.com',
      token: { access_token: 'access-test', refresh_token: 'refresh-test' },
    });
  });

  it('does not persist a duplicate Google account', async () => {
    vi.spyOn(GoogleAPIService, 'exchangeCode').mockResolvedValue({
      access_token: 'access-test',
      refresh_token: 'refresh-test',
      expires_in: 3600,
      token_type: 'Bearer',
      oauth_client_key: 'test',
    });
    vi.spyOn(GoogleAPIService, 'getUserInfo').mockResolvedValue({
      id: 'google-test',
      verified_email: true,
      email: 'example@example.com',
      name: 'Example',
      picture: '',
    });
    vi.spyOn(CloudAccountRepo, 'getAccountByEmail').mockResolvedValue({ id: 'existing' } as never);
    const add = vi.spyOn(CloudAccountRepo, 'addAccount');

    await expect(
      enrollGoogleAccount('code-test', { redirectUri: 'http://127.0.0.1:12345/oauth-callback' }),
    ).rejects.toBeInstanceOf(DuplicateGoogleAccountError);
    expect(add).not.toHaveBeenCalled();
  });
});
