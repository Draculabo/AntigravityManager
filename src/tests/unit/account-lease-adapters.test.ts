import { describe, expect, it, vi } from 'vitest';
import { AccountLeaseService } from '@/modules/proxy-gateway/server/modules/account-lease/account-lease.service';
import type {
  AccountLeaseAccountStore,
  AccountLeaseUpstream,
} from '@/modules/proxy-gateway/server/modules/account-lease/interfaces/account-lease-adapters';
import type { CloudAccount } from '@/modules/cloud-account/types';

describe('AccountLeaseService adapters', () => {
  it('uses storage and upstream adapters to hydrate a missing project id', async () => {
    const account: CloudAccount = {
      id: 'acc-1',
      provider: 'google',
      email: 'lease@example.com',
      token: {
        access_token: 'access-token',
        refresh_token: 'refresh-token',
        token_type: 'Bearer',
        expires_in: 3600,
        expiry_timestamp: Math.floor(Date.now() / 1000) + 3600,
      },
      created_at: 1,
      last_used: 1,
    };

    const accountStore: AccountLeaseAccountStore = {
      getAccounts: vi.fn().mockResolvedValue([account]),
      getAccount: vi.fn().mockResolvedValue(account),
      updateToken: vi.fn().mockResolvedValue(undefined),
      updateQuota: vi.fn().mockResolvedValue(undefined),
    };
    const upstream: AccountLeaseUpstream = {
      fetchQuota: vi.fn(),
      refreshAccessToken: vi.fn(),
      fetchProjectId: vi.fn().mockResolvedValue('resolved-project'),
      normalizeRefreshedOAuthClientKey: vi.fn(),
    };

    const service = new AccountLeaseService(accountStore, upstream);
    const lease = await service.getNextToken();

    expect(lease?.token.project_id).toBe('resolved-project');
    expect(upstream.fetchProjectId).toHaveBeenCalledWith('access-token', undefined);
    expect(accountStore.updateToken).toHaveBeenCalledWith(
      'acc-1',
      expect.objectContaining({
        project_id: 'resolved-project',
      }),
    );
  });
});
