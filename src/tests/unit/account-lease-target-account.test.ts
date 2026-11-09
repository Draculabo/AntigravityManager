import { afterEach, describe, expect, it, vi } from 'vitest';
import { CloudAccountHealthSchema, type CloudAccount } from '@/modules/cloud-account/types';
import { classifyForbiddenUpstreamError } from '@/modules/proxy-gateway/server/common/google-error-details';
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
    compareAndUpdateToken: vi.fn().mockResolvedValue(true),
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
  return { service, accounts, store, upstream };
}

describe('AccountLeaseService targetAccountId', () => {
  it('does not resurrect an evicted account when an in-flight refresh completes', async () => {
    const { service, accounts, upstream } = fixture();
    accounts[0].token.expiry_timestamp = 1;
    await service.loadAccounts();
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const resume = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.mocked(upstream.refreshAccessToken).mockImplementation(async () => {
      entered();
      await resume;
      return { access_token: 'refreshed', expires_in: 3600, token_type: 'Bearer' };
    });
    const selection = service.getNextToken({ targetAccountId: 'acc-alpha' });
    await started;
    service.evictAccount('acc-alpha');
    release();
    expect(await selection).toBeNull();
    expect(await service.getNextToken({ targetAccountId: 'acc-alpha' })).toBeNull();
  });

  it('does not resurrect an evicted account when project discovery completes', async () => {
    const { service, accounts, upstream } = fixture();
    accounts[0].token.project_id = undefined;
    await service.loadAccounts();
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const resume = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.mocked(upstream.fetchProjectId).mockImplementation(async () => {
      entered();
      await resume;
      return 'discovered-project';
    });
    const selection = service.getNextToken({ targetAccountId: 'acc-alpha' });
    await started;
    service.evictAccount('acc-alpha');
    release();
    expect(await selection).toBeNull();
    expect(await service.getNextToken({ targetAccountId: 'acc-alpha' })).toBeNull();
  });

  it('never leases a cached account when every profile read fails', async () => {
    const { service, store } = fixture();
    await service.loadAccounts();
    vi.mocked(store.getAccount).mockRejectedValue(new Error('storage unavailable'));

    await expect(service.getNextToken()).resolves.toBeNull();
    expect(store.getAccount).toHaveBeenCalledTimes(1);
  });

  it('selects another account when the selected account disappears during fulfillment', async () => {
    const { service, accounts, store } = fixture();
    await service.loadAccounts();
    let missingId: string | undefined;
    vi.mocked(store.getAccount).mockImplementation(async (id) => {
      if (!missingId) {
        missingId = id;
        return undefined;
      }
      return structuredClone(accounts.find((account) => account.id === id));
    });
    const lease = await service.getNextToken();
    expect(lease).not.toBeNull();
    expect(lease?.id).not.toBe(missingId);
    expect(store.getAccount).toHaveBeenCalledTimes(2);
  });

  it('does not issue a lease quarantined while the device profile is being read', async () => {
    const { service, accounts, store } = fixture();
    await service.loadAccounts();
    let release!: () => void;
    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const resume = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.mocked(store.getAccount).mockImplementation(async () => {
      entered();
      await resume;
      return structuredClone(accounts[0]);
    });
    const selection = service.getNextToken({ targetAccountId: 'acc-alpha' });
    await waiting;
    service.quarantineAccountInMemory('acc-alpha');
    release();
    expect(await selection).toBeNull();
  });
  it('preserves the configured device profile when leasing an account', async () => {
    const { service, accounts } = fixture();
    accounts[0].device_profile = {
      machineId: 'configured-machine',
      macMachineId: 'mac',
      devDeviceId: 'device',
      sqmId: 'sqm',
    };
    await service.loadAccounts();
    expect((await service.getNextToken({ targetAccountId: 'acc-alpha' }))?.device_profile).toEqual(
      accounts[0].device_profile,
    );
  });

  it('uses an updated device binding without reloading the lease cache', async () => {
    const { service, accounts } = fixture();
    accounts[0].device_profile = {
      machineId: 'old-machine',
      macMachineId: 'mac',
      devDeviceId: 'device',
      sqmId: 'sqm',
    };
    await service.loadAccounts();
    expect(
      (await service.getNextToken({ targetAccountId: 'acc-alpha' }))?.device_profile?.machineId,
    ).toBe('old-machine');
    accounts[0].device_profile = { ...accounts[0].device_profile, machineId: 'new-machine' };
    expect(
      (await service.getNextToken({ targetAccountId: 'acc-alpha' }))?.device_profile?.machineId,
    ).toBe('new-machine');
  });
  it('persists a ToS classification with a bounded long appeal label', async () => {
    const { service, accounts, store } = fixture();
    vi.mocked(store.mutateHealth).mockImplementation(async (id, mutate) => {
      const account = accounts.find((item) => item.id === id)!;
      account.health = CloudAccountHealthSchema.parse(mutate(account.health));
      return account.health;
    });
    const result = classifyForbiddenUpstreamError({
      details: [
        {
          reason: 'TOS_VIOLATION',
          metadata: { appeal_url: 'https://forms.gle/test', appeal_url_link_text: 'x'.repeat(160) },
        },
      ],
    });
    await service.markServiceDisabled({
      accountId: 'acc-alpha',
      reason: result.reason!,
      appealUrl: result.appealUrl,
      appealLinkText: result.appealLinkText,
    });
    expect(accounts[0].health?.service_disabled?.appeal_url_link_text).toBe('x'.repeat(100));
  });
  it('does not clear a newer quarantine when a manual release completes late', async () => {
    const { service } = fixture();
    await service.loadAccounts();
    service.quarantineAccountInMemory('acc-alpha');
    const generation = service.getMemoryQuarantineGeneration('acc-alpha');
    service.quarantineAccountInMemory('acc-alpha');
    service.clearMemoryQuarantine('acc-alpha', generation);
    expect(await service.getNextToken({ targetAccountId: 'acc-alpha' })).toBeNull();
  });
  it('keeps the loaded account quarantined if persisting ToS health fails', async () => {
    const { service, store } = fixture();
    await service.loadAccounts();
    vi.mocked(store.mutateHealth).mockRejectedValueOnce(new Error('storage failed'));
    await expect(
      service.markServiceDisabled({ accountId: 'acc-alpha', reason: 'TOS_VIOLATION' }),
    ).rejects.toThrow('storage failed');
    expect(await service.getNextToken({ targetAccountId: 'acc-alpha' })).toBeNull();
    await service.reloadAllAccountsOrThrow();
    expect(await service.getNextToken({ targetAccountId: 'acc-alpha' })).toBeNull();
    expect((await service.getNextToken({ targetAccountId: 'acc-beta' }))?.id).toBe('acc-beta');
    service.clearMemoryQuarantine('acc-alpha', service.getMemoryQuarantineGeneration('acc-alpha'));
    expect((await service.getNextToken({ targetAccountId: 'acc-alpha' }))?.id).toBe('acc-alpha');
  });
  it('honors model-specific upstream lockouts for targeted leases', async () => {
    const { service } = fixture();
    await service.loadAccounts();
    await service.markFromUpstreamError({
      accountIdOrEmail: 'acc-beta',
      status: 429,
      retryAfter: '60',
      model: 'gemini-3-flash',
    });
    expect(
      await service.getNextToken({ targetAccountId: 'acc-beta', model: 'gemini-3-flash' }),
    ).toBeNull();
    expect(
      (await service.getNextToken({ targetAccountId: 'acc-alpha', model: 'gemini-3-flash' }))?.id,
    ).toBe('acc-alpha');
  });
  it('does not lease an excluded target, including an email target', async () => {
    const { service } = fixture();
    await service.loadAccounts();
    expect(
      await service.getNextToken({
        targetAccountId: 'BETA@EXAMPLE.COM',
        excludeAccountIds: ['acc-beta'],
        model: 'gemini-3-flash',
      }),
    ).toBeNull();
  });

  it.each(['markAsForbidden', 'markAsRateLimited'] as const)(
    'does not bypass %s for the targeted account',
    async (mark) => {
      const { service } = fixture();
      await service.loadAccounts();
      service[mark]('acc-beta');
      expect(
        await service.getNextToken({
          targetAccountId: 'acc-beta',
          model: 'gemini-3-flash',
        }),
      ).toBeNull();
    },
  );

  it('does not lease a target with depleted model quota', async () => {
    const { service, accounts } = fixture();
    accounts[1].quota!.models['gemini-3-flash'].percentage = 0;
    await service.loadAccounts();
    expect(
      await service.getNextToken({
        targetAccountId: 'acc-beta',
        model: 'gemini-3-flash',
      }),
    ).toBeNull();
  });

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

  it('returns null and excludes from pool when account is service disabled', async () => {
    const { service } = fixture();
    await service.loadAccounts();

    await service.markServiceDisabled({
      accountId: 'acc-alpha',
      reason: 'TOS_VIOLATION',
      appealUrl: 'https://forms.gle/appeal',
    });

    const targetLeased = await service.getNextToken({
      targetAccountId: 'acc-alpha',
      model: 'gemini-3-flash',
    });
    expect(targetLeased).toBeNull();

    // From pool: only acc-beta should be available
    const poolLeased = await service.getNextToken({
      model: 'gemini-3-flash',
    });
    expect(poolLeased?.id).toBe('acc-beta');
  });
});
