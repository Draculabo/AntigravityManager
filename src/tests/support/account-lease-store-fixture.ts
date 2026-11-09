import type { CloudAccount, CloudTokenData } from '@/modules/cloud-account/types';
import type { AccountLeaseAccountStore } from '@/modules/proxy-gateway/server/modules/account-lease/interfaces/account-lease-adapters';

export function leaseAccount(id: string, token: Partial<CloudTokenData> = {}): CloudAccount {
  return {
    id,
    provider: 'google',
    email: `${id}@test.dev`,
    created_at: 1,
    last_used: 1,
    token: {
      access_token: `token-${id}`,
      refresh_token: `refresh-${id}`,
      token_type: 'Bearer',
      expires_in: 3600,
      expiry_timestamp: Math.floor(Date.now() / 1000) + 3600,
      project_id: `project-${id}`,
      ...token,
    },
  };
}

export function accountLeaseStoreFixture(initial: CloudAccount[]) {
  const accounts = new Map(initial.map((account) => [account.id, structuredClone(account)]));
  const store: AccountLeaseAccountStore = {
    async getAccounts() {
      return structuredClone([...accounts.values()]);
    },
    async getAccount(id) {
      return structuredClone(accounts.get(id));
    },
    async updateToken(id, token) {
      const account = accounts.get(id);
      if (account) {
        account.token = structuredClone(token);
      }
    },
    async compareAndUpdateToken(id, expected, token) {
      const account = accounts.get(id);
      if (!account || JSON.stringify(account.token) !== JSON.stringify(expected)) {
        return false;
      }
      account.token = structuredClone(token);
      return true;
    },
    async updateQuota(id, quota) {
      const account = accounts.get(id);
      if (account) {
        account.quota = structuredClone(quota);
      }
    },
    async mutateHealth(id, mutation) {
      const account = accounts.get(id);
      if (!account) {
        throw new Error('Missing fixture account');
      }
      account.health = structuredClone(mutation(account.health));
      return structuredClone(account.health);
    },
  };
  return { accounts, store };
}
