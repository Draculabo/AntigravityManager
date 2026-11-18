import { afterEach, describe, expect, it, vi } from 'vitest';
import { AccountLeaseService } from '@/server/gateway/modules/account-lease/account-lease.service';
import type {
  AccountLeaseAccountStore,
  AccountLeaseUpstream,
} from '@/server/gateway/modules/account-lease/interfaces/account-lease-adapters';
import type { CloudAccountOAuthLeaseContext } from '@/modules/cloud-account/types';
import { createAccount } from './proxy-real-path.harness';

const services: AccountLeaseService[] = [];
afterEach(async () => {
  for (const service of services.splice(0)) {
    await service.onModuleDestroy();
  }
});
async function fixture() {
  const account = createAccount('oauth-live');
  account.token.oauth_client_key = ' CLIENT-KEY ';
  account.proxy_url = 'http://127.0.0.1:8046';
  const store: AccountLeaseAccountStore = {
    getAccounts: vi.fn(async () => [structuredClone(account)]),
    getAccount: vi.fn(async (id) => (id === account.id ? structuredClone(account) : undefined)),
    async compareAndUpdateToken(id, _expected, token, guard) {
      await this.updateToken(id, token, guard);
      return true;
    },
    updateToken: vi.fn(),
    updateQuota: vi.fn(),
    mutateHealth: vi.fn(),
  };
  const upstream: AccountLeaseUpstream = {
    fetchQuota: vi.fn(),
    fetchProjectId: vi.fn(),
    refreshAccessToken: vi.fn(),
    normalizeRefreshedOAuthClientKey: vi.fn(),
  };
  const lease = new AccountLeaseService(store, upstream);
  services.push(lease);
  await lease.loadAccounts();
  const context: CloudAccountOAuthLeaseContext = {
    email: account.email,
    refreshToken: account.token.refresh_token,
    oauthClientKey: account.token.oauth_client_key,
    proxyUrl: account.proxy_url,
  };
  return { account, lease, context };
}

describe('OAuth live-cache context enforcement', () => {
  it.each(['refreshToken', 'email', 'oauthClientKey', 'proxyUrl'] as const)(
    'refuses a stale %s for both OAuth side effects',
    async (field) => {
      const { lease, context } = await fixture();
      context[field] = 'obsolete-context';
      expect(lease.updateAccountOAuthHealth('oauth-live', { refresh_blocked: true }, context)).toBe(
        false,
      );
      expect(lease.evictAccount('oauth-live', context)).toBe(false);
      expect(lease.getAccountCount()).toBe(1);
      expect((await lease.getNextToken())?.id).toBe('oauth-live');
    },
  );

  it('allows a matching normalized context and retains unconditional eviction for deletion callers', async () => {
    const { lease, context } = await fixture();
    expect(lease.updateAccountOAuthHealth('oauth-live', { refresh_blocked: false }, context)).toBe(
      true,
    );
    expect(lease.evictAccount('oauth-live', context)).toBe(true);
    expect(lease.getAccountCount()).toBe(0);
    expect(lease.updateAccountOAuthHealth('oauth-live', { refresh_blocked: false }, context)).toBe(
      false,
    );
    expect(lease.evictAccount('oauth-live', context)).toBe(false);
  });

  it('does not apply old side effects to an account reloaded with new credentials', async () => {
    const { account, lease, context } = await fixture();
    account.token.refresh_token = 'reauthorized-refresh';
    await lease.loadAccounts();
    expect(lease.updateAccountOAuthHealth('oauth-live', { refresh_blocked: true }, context)).toBe(
      false,
    );
    expect(lease.evictAccount('oauth-live', context)).toBe(false);
    expect((await lease.getNextToken())?.token.refresh_token).toBe('reauthorized-refresh');
    expect(lease.evictAccount('oauth-live')).toBe(true);
  });
});
