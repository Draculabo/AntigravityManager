import { describe, expect, it, vi } from 'vitest';
import {
  createCloudAccountListService,
  type CloudAccountListDependencies,
} from '@/modules/cloud-account/services/cloud-account-list.service';
import type { CloudAccount } from '@/modules/cloud-account/types';

function account(id: string, email: string): CloudAccount {
  return {
    id,
    provider: 'google',
    email,
    token: {
      access_token: `secret-${id}`,
      refresh_token: `secret-refresh-${id}`,
      expires_in: 3600,
      expiry_timestamp: 1000,
      token_type: 'Bearer',
    },
    quota: {
      models: { gemini: { percentage: 50, resetTime: 'later', supports_images: true } },
      model_forwarding_rules: { gemini: 'server-only-routing' },
    },
    proxy_url: 'http://secret-user:secret-password@127.0.0.1:7890',
    created_at: 1,
    last_used: 2,
  };
}

function dependencies(
  accounts: CloudAccount[],
  overrides: Partial<CloudAccountListDependencies> = {},
): CloudAccountListDependencies {
  return {
    getAccounts: vi.fn(async () => accounts),
    backfillOAuthClientKeys: vi.fn(async () => false),
    refreshProcessCache: vi.fn(async () => {}),
    getCurrentAccountInfo: vi.fn(() => ({ isAuthenticated: false, email: '' })),
    usesCredentialStore: vi.fn(() => false),
    getActiveAccountId: vi.fn(() => ''),
    warn: vi.fn(),
    ...overrides,
  };
}

describe('cloud account list service', () => {
  const accounts = [
    account('classic', 'old@example.com'),
    account('ide', 'ide@example.com'),
    account('agy', 'agy@example.com'),
  ];

  it('preserves Classic credential ID precedence, IDE email, and Agy ID flags', async () => {
    const deps = dependencies(accounts, {
      usesCredentialStore: () => true,
      getCurrentAccountInfo: (target) => ({
        isAuthenticated: true,
        email: target === 'classic' ? 'OLD@example.com' : ' IDE@example.com ',
      }),
      getActiveAccountId: vi.fn((target) =>
        target === 'classic' ? 'agy' : target === 'agy' ? 'agy' : 'classic',
      ),
    });

    const views = await createCloudAccountListService(deps).listViews();

    expect(
      views.map(({ id, is_active, is_active_classic, is_active_ide, is_active_agy }) => ({
        id,
        is_active,
        is_active_classic,
        is_active_ide,
        is_active_agy,
      })),
    ).toEqual([
      {
        id: 'classic',
        is_active: false,
        is_active_classic: false,
        is_active_ide: false,
        is_active_agy: false,
      },
      {
        id: 'ide',
        is_active: true,
        is_active_classic: false,
        is_active_ide: true,
        is_active_agy: false,
      },
      {
        id: 'agy',
        is_active: true,
        is_active_classic: true,
        is_active_ide: false,
        is_active_agy: true,
      },
    ]);
    expect(JSON.stringify(views)).not.toMatch(
      /secret-|access_token|refresh_token|proxy_url|model_forwarding_rules|supports_images/,
    );
    expect(deps.refreshProcessCache).toHaveBeenCalledWith('classic');
    expect(deps.refreshProcessCache).toHaveBeenCalledWith('ide');
    expect(deps.getActiveAccountId).not.toHaveBeenCalledWith('ide');
  });

  it('uses Classic email mode and IDE stored ID when authentication is absent', async () => {
    const deps = dependencies(accounts, {
      getCurrentAccountInfo: (target) => ({
        isAuthenticated: target === 'classic',
        email: target === 'classic' ? ' OLD@example.com ' : '',
      }),
      getActiveAccountId: vi.fn((target) => (target === 'ide' ? 'ide' : '')),
    });

    const views = await createCloudAccountListService(deps).listViews();
    expect(
      views.map(({ id, is_active_classic, is_active_ide }) => [
        id,
        is_active_classic,
        is_active_ide,
      ]),
    ).toEqual([
      ['classic', true, false],
      ['ide', false, true],
      ['agy', false, false],
    ]);
    expect(deps.getActiveAccountId).not.toHaveBeenCalledWith('classic');
  });

  it('refetches after the legacy OAuth-client-key backfill before projecting', async () => {
    const getAccounts = vi
      .fn<() => Promise<CloudAccount[]>>()
      .mockResolvedValueOnce([account('classic', 'old@example.com')])
      .mockResolvedValueOnce([{ ...account('classic', 'old@example.com'), name: 'Updated' }]);
    const deps = dependencies([], {
      getAccounts,
      backfillOAuthClientKeys: vi.fn(async () => true),
    });

    const views = await createCloudAccountListService(deps).listViews();
    expect(views).toEqual([
      {
        id: 'classic',
        provider: 'google',
        email: 'old@example.com',
        name: 'Updated',
        quota: { models: { gemini: { percentage: 50, resetTime: 'later' } } },
        created_at: 1,
        last_used: 2,
        is_active: false,
        is_active_classic: false,
        is_active_ide: false,
        is_active_agy: false,
        proxy_configured: true,
      },
    ]);
    expect(getAccounts).toHaveBeenCalledTimes(2);
    expect(deps.backfillOAuthClientKeys).toHaveBeenCalledWith([
      expect.objectContaining({ id: 'classic', email: 'old@example.com' }),
    ]);
  });
});
