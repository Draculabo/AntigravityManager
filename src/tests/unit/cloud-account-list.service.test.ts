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
    readAgyAccountToken: vi.fn(async () => null),
    readSystemAccountToken: vi.fn(async () => null),
    isClientInstalled: vi.fn(() => false),
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
      usesCredentialStore: (target) => target === 'classic',
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

  it('moves the CLI badge on a new external login without changing the desktop badges', async () => {
    const deps = dependencies(accounts, {
      getCurrentAccountInfo: (target) => ({
        isAuthenticated: true,
        email: target === 'classic' ? 'old@example.com' : 'ide@example.com',
      }),
      readAgyAccountToken: vi
        .fn<CloudAccountListDependencies['readAgyAccountToken']>()
        .mockResolvedValueOnce({ refreshToken: 'secret-refresh-ide' })
        .mockResolvedValueOnce({ refreshToken: 'secret-refresh-classic' }),
      getActiveAccountId: vi.fn((target) => (target === 'agy' ? 'agy' : '')),
    });
    const service = createCloudAccountListService(deps);
    const getFlags = async () =>
      (await service.listViews()).map(({ id, is_active_classic, is_active_ide, is_active_agy }) => [
        id,
        is_active_classic,
        is_active_ide,
        is_active_agy,
      ]);

    expect(await getFlags()).toEqual([
      ['classic', true, false, false],
      ['ide', false, true, true],
      ['agy', false, false, false],
    ]);
    expect(await getFlags()).toEqual([
      ['classic', true, false, true],
      ['ide', false, true, false],
      ['agy', false, false, false],
    ]);
    expect(deps.getActiveAccountId).not.toHaveBeenCalledWith('agy');
  });

  it('marks a newly imported keyring login when the CLI is the only installed keyring client', async () => {
    const deps = dependencies(accounts, {
      usesCredentialStore: (target) => target === 'classic',
      readSystemAccountToken: async () => ({ refreshToken: 'secret-refresh-agy' }),
      isClientInstalled: (target) => target === 'agy' || target === 'ide',
    });

    const views = await createCloudAccountListService(deps).listViews();
    expect(views.filter((view) => view.is_active_agy).map((view) => view.id)).toEqual(['agy']);
  });

  it.each(['classic', 'ide'] as const)(
    'does not treat the shared keyring as a CLI login when %s also uses it',
    async (desktop) => {
      const deps = dependencies(accounts, {
        usesCredentialStore: (target) => target === desktop,
        readSystemAccountToken: async () => ({ refreshToken: 'secret-refresh-agy' }),
        isClientInstalled: (target) => target === 'agy' || target === desktop,
      });

      const views = await createCloudAccountListService(deps).listViews();
      expect(views.filter((view) => view.is_active_agy)).toEqual([]);
    },
  );

  it('does not show a stale CLI badge for an unmatched login on a CLI-only installation', async () => {
    const deps = dependencies(accounts, {
      readSystemAccountToken: async () => ({ refreshToken: 'synthetic-unimported' }),
      isClientInstalled: (target) => target === 'agy',
      getActiveAccountId: (target) => (target === 'agy' ? 'agy' : ''),
    });

    const views = await createCloudAccountListService(deps).listViews();
    expect(views.filter((view) => view.is_active_agy)).toEqual([]);
  });

  it.each([
    { match: 'no', refreshToken: 'synthetic-unimported', accounts },
    {
      match: 'only Anthropic',
      refreshToken: 'secret-refresh-agy',
      accounts: accounts.map((account) =>
        account.id === 'agy' ? { ...account, provider: 'anthropic' as const } : account,
      ),
    },
    {
      match: 'multiple',
      refreshToken: 'secret-refresh-agy',
      accounts: [...accounts, { ...accounts[2], id: 'duplicate', email: 'duplicate@example.com' }],
    },
  ])('suppresses the saved CLI badge when the session has $match matches', async (fixture) => {
    const deps = dependencies(fixture.accounts, {
      readAgyAccountToken: async () => ({ refreshToken: fixture.refreshToken }),
      getActiveAccountId: vi.fn((target) => (target === 'agy' ? 'agy' : '')),
    });

    const views = await createCloudAccountListService(deps).listViews();
    expect(views.filter((view) => view.is_active_agy || view.is_active)).toEqual([]);
    expect(deps.getActiveAccountId).not.toHaveBeenCalledWith('agy');
  });

  it('retains the saved CLI badge when the dedicated session cannot be read', async () => {
    const error = new Error('Unexpected read failure with synthetic private value');
    const deps = dependencies(accounts, {
      readAgyAccountToken: vi.fn().mockRejectedValue(error),
      getActiveAccountId: vi.fn((target) => (target === 'agy' ? 'agy' : '')),
    });

    const views = await createCloudAccountListService(deps).listViews();
    expect(
      views.filter((view) => view.is_active_agy && view.is_active).map((view) => view.id),
    ).toEqual(['agy']);
    expect(deps.warn).toHaveBeenCalledWith(
      'Failed to read the agy session file during listing',
      'unavailable',
    );
  });

  it('uses IDE credential-store ID when IDE uses the credential store', async () => {
    const deps = dependencies(accounts, {
      usesCredentialStore: (target) => target === 'ide',
      getCurrentAccountInfo: vi.fn(() => ({ isAuthenticated: false, email: '' })),
      getActiveAccountId: vi.fn((target) => (target === 'ide' ? 'ide' : '')),
    });

    const views = await createCloudAccountListService(deps).listViews();
    expect(
      views.map(({ id, is_active_classic, is_active_ide, is_active_agy }) => [
        id,
        is_active_classic,
        is_active_ide,
        is_active_agy,
      ]),
    ).toEqual([
      ['classic', false, false, false],
      ['ide', false, true, false],
      ['agy', false, false, false],
    ]);
    // IDE credential store skips the SQLite email lookup entirely
    expect(deps.getCurrentAccountInfo).not.toHaveBeenCalledWith('ide');
    expect(deps.getActiveAccountId).toHaveBeenCalledWith('ide');
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
        quota: {
          models: { gemini: { percentage: 50, resetTime: 'later' } },
          is_forbidden: false,
        },
        created_at: 1,
        last_used: 2,
        is_active: false,
        is_active_classic: false,
        is_active_ide: false,
        is_active_agy: false,
        proxy_priority: 50,
        proxy_enabled: true,
        proxy_configured: true,
      },
    ]);
    expect(getAccounts).toHaveBeenCalledTimes(2);
    expect(deps.backfillOAuthClientKeys).toHaveBeenCalledWith([
      expect.objectContaining({ id: 'classic', email: 'old@example.com' }),
    ]);
  });
});
