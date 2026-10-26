import type { CloudAccount, CloudAccountOAuthLeaseContext } from '../types';

export class CloudAccountRefreshContextChangedError extends Error {
  constructor(accountId: string, options?: ErrorOptions) {
    super(`Account ${accountId} changed during OAuth refresh`, options);
    this.name = 'CloudAccountRefreshContextChangedError';
  }
}

/** Capture primitive values, not a mutable account object returned by an adapter. */
export function captureRefreshContext(account: CloudAccount): {
  leaseContext: CloudAccountOAuthLeaseContext;
  assertCurrent(current: CloudAccount | undefined, cause?: unknown): void;
} {
  const { id, provider, email, created_at, proxy_url, lifecycle_generation } = account;
  const { refresh_token, oauth_client_key, upstream_proxy_url } = account.token;
  return {
    leaseContext: {
      ...(lifecycle_generation ? { lifecycleGeneration: lifecycle_generation } : {}),
      email,
      refreshToken: refresh_token,
      oauthClientKey: oauth_client_key,
      proxyUrl: upstream_proxy_url || proxy_url || undefined,
    },
    assertCurrent(current, cause) {
      if (
        !current ||
        (lifecycle_generation !== undefined &&
          current.lifecycle_generation !== lifecycle_generation) ||
        current.id !== id ||
        current.provider !== provider ||
        current.email !== email ||
        current.created_at !== created_at ||
        current.proxy_url !== proxy_url ||
        current.token.refresh_token !== refresh_token ||
        current.token.oauth_client_key !== oauth_client_key ||
        current.token.upstream_proxy_url !== upstream_proxy_url
      ) {
        throw new CloudAccountRefreshContextChangedError(id, { cause });
      }
    },
  };
}
