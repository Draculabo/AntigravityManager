import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CloudAccount } from '@/modules/cloud-account/types';
import { CredentialStoreInjectionAdapter } from '@/modules/cloud-account/persistence/credential-store-injection-adapter';
import { writeAntigravityCredentialStoreToken } from '@/modules/cloud-account/persistence/antigravityCredentialStore';

vi.mock('@/modules/cloud-account/persistence/antigravityCredentialStore', () => ({
  writeAntigravityCredentialStoreToken: vi.fn(),
}));

function createAccount(expiryTimestamp: number, refreshToken: string): CloudAccount {
  const now = Math.floor(Date.now() / 1000);
  return {
    id: 'expired-account',
    provider: 'google',
    email: 'expired@example.com',
    name: 'Expired User',
    avatar_url: '',
    token: {
      access_token: 'access-token',
      refresh_token: refreshToken,
      expires_in: 3600,
      expiry_timestamp: expiryTimestamp,
      token_type: 'Bearer',
      email: 'expired@example.com',
    },
    created_at: now - 7200,
    last_used: now - 3600,
    status: 'active',
    is_active: false,
  };
}

describe('CredentialStoreInjectionAdapter token expiry guard', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it('rejects expired access tokens when no refresh token is available', () => {
    const now = Math.floor(Date.now() / 1000);
    const account = createAccount(now - 1, '');
    vi.spyOn(
      CredentialStoreInjectionAdapter,
      'shouldInjectTokenIntoCredentialStore',
    ).mockReturnValue(true);

    expect(() =>
      CredentialStoreInjectionAdapter.injectCloudTokenWithStorageStrategy(account),
    ).toThrow(/expired access token.*without a refresh token/i);
    expect(writeAntigravityCredentialStoreToken).not.toHaveBeenCalled();
  });

  it('keeps valid access tokens usable when no refresh token is available yet', () => {
    const now = Math.floor(Date.now() / 1000);
    const account = createAccount(now + 300, '');
    vi.spyOn(
      CredentialStoreInjectionAdapter,
      'shouldInjectTokenIntoCredentialStore',
    ).mockReturnValue(true);

    expect(CredentialStoreInjectionAdapter.injectCloudTokenWithStorageStrategy(account)).toBe(
      'credential-store',
    );
    expect(writeAntigravityCredentialStoreToken).toHaveBeenCalledWith(account.token);
  });
});
