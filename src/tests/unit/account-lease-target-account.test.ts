import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CloudAccount } from '@/modules/cloud-account/types';
import { DEFAULT_APP_CONFIG } from '@/modules/config/types';
import { getServerConfig, setServerConfig } from '@/server/server-config';
import { AccountLeaseService } from '@/modules/proxy-gateway/server/modules/account-lease/account-lease.service';
import type {
  AccountLeaseAccountStore,
  AccountLeaseUpstream,
} from '@/modules/proxy-gateway/server/modules/account-lease/interfaces/account-lease-adapters';

const previous = getServerConfig() ?? DEFAULT_APP_CONFIG.proxy;
afterEach(() => {
  setServerConfig(previous);
});

function fixture() {
  const now = Math.floor(Date.now() / 1000);
  const accounts: CloudAccount[] = [
    {
      id: 'acc-alpha',
      provider: 'google',
      email: 'alpha@example.com',
      created_at: 1,
      last_used: 1,
      token: {
        access_token: 'access-alpha',
        refresh_token: 'refresh-alpha',
        expires_in: 3600,
        expiry_timestamp: now + 3600,
        token_type: 'Bearer',
        project_id: 'proj-alpha',
      },
      quota: {
        models: {
          'gemini-3-flash': { percentage: 100, resetTime: '' },
          'claude-sonnet': { percentage: 100, resetTime: '' },
        },
      },
    },
    {
      id: 'acc-beta',
      provider: 'google',
      email: 'beta@example.com',
      created_at: 1,
      last_used: 1,
      token: {
        access_token: 'access-beta',
        refresh_token: 'refresh-beta',
        expires_in: 3600,
        expiry_timestamp: now + 3600,
        token_type: 'Bearer',
        project_id: 'proj-beta',
      },
      quota: {
        models: {
          'gemini-3-flash': { percentage: 50, resetTime: '' },
        },
      },
    },
  ];

  const store: AccountLeaseAccountStore = {
    getAccounts: vi.fn(async () => structuredClone(accounts)),
    getAccount: vi.fn(async (id) => structuredClone(accounts.find((a) => a.id === id))),
    updateToken: vi.fn(),
    updateQuota: vi.fn(),
    mutateHealth: vi.fn(),
  };

  const upstream: AccountLeaseUpstream = {
    fetchQuota: vi.fn(),
    refreshAccessToken: vi.fn(async () => ({
      access_token: 'refreshed',
      expires_in: 3600,
      token_type: 'Bearer',
    })),
    fetchProjectId: vi.fn(),
    normalizeRefreshedOAuthClientKey: vi.fn(),
  };

  const service = new AccountLeaseService(store, upstream);
  return { service, accounts };
}

describe('AccountLeaseService targetAccountId', () => {
  it('leases the exact targeted account by account ID', async () => {
    const { service } = fixture();
    await service.loadAccounts();

    const leased = await service.getNextToken({
      targetAccountId: 'acc-beta',
      model: 'gemini-3-flash',
    });

    expect(leased).not.toBeNull();
    expect(leased?.id).toBe('acc-beta');
    expect(leased?.email).toBe('beta@example.com');
  });

  it('leases the exact targeted account by email case-insensitively', async () => {
    const { service } = fixture();
    await service.loadAccounts();

    const leased = await service.getNextToken({
      targetAccountId: 'ALPHA@EXAMPLE.COM',
      model: 'gemini-3-flash',
    });

    expect(leased).not.toBeNull();
    expect(leased?.id).toBe('acc-alpha');
  });

  it('returns null when target account does not exist in pool', async () => {
    const { service } = fixture();
    await service.loadAccounts();

    const leased = await service.getNextToken({
      targetAccountId: 'nonexistent-account',
      model: 'gemini-3-flash',
    });

    expect(leased).toBeNull();
  });

  it('returns null when target account does not support requested model', async () => {
    const { service } = fixture();
    await service.loadAccounts();

    // acc-beta only has gemini-3-flash, not claude-sonnet
    const leased = await service.getNextToken({
      targetAccountId: 'acc-beta',
      model: 'claude-sonnet',
    });

    expect(leased).toBeNull();
  });

  it('returns null when target account is validation blocked', async () => {
    const { service } = fixture();
    await service.loadAccounts();

    await service.markValidationRequired({
      accountId: 'acc-alpha',
      verificationUrl: 'https://accounts.google.com/verify',
      description: 'Suspicious activity',
    });

    const leased = await service.getNextToken({
      targetAccountId: 'acc-alpha',
      model: 'gemini-3-flash',
    });

    expect(leased).toBeNull();
  });
});
