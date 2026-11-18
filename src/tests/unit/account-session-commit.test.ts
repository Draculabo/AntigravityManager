import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountLeaseService } from '@/server/gateway/modules/account-lease/account-lease.service';
import type {
  AccountLeaseAccountStore,
  AccountLeaseUpstream,
} from '@/server/gateway/modules/account-lease/interfaces/account-lease-adapters';
import { DEFAULT_APP_CONFIG, type ProxyConfig } from '@/modules/config/types';
import { getServerConfig, setServerConfig } from '@/server/server-config';
import { createAccount } from './proxy-real-path.harness';

const previous = getServerConfig() ?? DEFAULT_APP_CONFIG.proxy;
const services: AccountLeaseService[] = [];
async function fixture(overrides: Partial<ProxyConfig> = {}) {
  setServerConfig({
    ...DEFAULT_APP_CONFIG.proxy,
    quota_aware_scheduling_enabled: false,
    ...overrides,
  });
  const accounts = ['affinity-a', 'affinity-b'].map((id) => createAccount(id));
  const store: AccountLeaseAccountStore = {
    getAccounts: vi.fn(async () => structuredClone(accounts)),
    getAccount: vi.fn(async (id) => structuredClone(accounts.find((account) => account.id === id))),
    async compareAndUpdateToken(id, _expected, token, guard) {
      await this.updateToken(id, token, guard);
      return true;
    },
    updateToken: vi.fn(),
    updateQuota: vi.fn(),
    mutateHealth: vi.fn(),
  };
  const upstream: AccountLeaseUpstream = {
    refreshAccessToken: vi.fn(),
    fetchQuota: vi.fn(),
    fetchProjectId: vi.fn(),
    normalizeRefreshedOAuthClientKey: vi.fn(),
  };
  const lease = new AccountLeaseService(store, upstream);
  services.push(lease);
  await lease.loadAccounts();
  const select = (excludeAccountIds: string[] = []) =>
    lease.getNextToken({
      sessionKey: 'session-controlled',
      model: 'gemini-3-flash',
      excludeAccountIds,
    });
  return { lease, select, accounts, upstream, store };
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});
afterEach(async () => {
  for (const service of services.splice(0)) {
    await service.onModuleDestroy();
  }
  setServerConfig(previous);
  vi.useRealTimers();
});

describe('success-only account affinity through the real lease', () => {
  it('does not bind an account merely because hydration succeeded', async () => {
    const { select } = await fixture();
    expect((await select())?.id).toBe('affinity-a');
    expect((await select())?.id).toBe('affinity-b');
  });

  it('commits only the successful candidate and starts TTL at success', async () => {
    const { lease, select } = await fixture();
    const first = await select();
    const second = await select(['affinity-a']);
    lease.rejectSession(first!);
    await vi.advanceTimersByTimeAsync(590_000);
    lease.commitSession(second!);
    await vi.advanceTimersByTimeAsync(20_000);
    expect((await select())?.id).toBe('affinity-b');
    await vi.advanceTimersByTimeAsync(600_000);
    expect((await select())?.id).toBe('affinity-a');
    expect((await select())?.id).toBe('affinity-b');
  });

  it('keeps a concurrent success on the same account when an older request fails', async () => {
    const { lease, select } = await fixture();
    const seed = await select();
    lease.commitSession(seed!);
    const older = await select();
    const newer = await select();
    lease.commitSession(newer!);
    lease.rejectSession(older!);
    expect((await select())?.id).toBe('affinity-a');
    expect((await select())?.id).toBe('affinity-a');
  });

  it('keeps a concurrent success on a different account when an older request fails', async () => {
    const { lease, select } = await fixture();
    const seed = await select();
    lease.commitSession(seed!);
    const older = await select();
    const newer = await select(['affinity-a']);
    lease.commitSession(newer!);
    lease.rejectSession(older!);
    expect((await select())?.id).toBe('affinity-b');
  });

  it('abandons only the failed binding observed by that lease', async () => {
    const { lease, select } = await fixture();
    const seed = await select();
    lease.commitSession(seed!);
    const failed = await select();
    lease.rejectSession(failed!);
    expect((await select())?.id).toBe('affinity-b');
  });

  it('allows a grace success to commit after its failed normal send abandoned old affinity', async () => {
    const { lease, select } = await fixture();
    const seed = await select();
    lease.commitSession(seed!);
    const retry = await select();
    lease.rejectSession(retry!);
    lease.commitSession(retry!);
    expect((await select())?.id).toBe('affinity-a');
    lease.rejectSession(retry!);
    expect((await select())?.id).toBe('affinity-a');
  });

  it('does not let a repeated success callback replace a newer successful binding', async () => {
    const { lease, select } = await fixture();
    const first = await select();
    lease.commitSession(first!);
    const second = await select(['affinity-a']);
    lease.commitSession(second!);
    lease.commitSession(first!);
    expect((await select())?.id).toBe('affinity-b');
  });

  it('does not replace account-first retention with an unconfirmed fallback candidate', async () => {
    const { lease, select } = await fixture({ account_selection_strategy: 'account-first' });
    const stable = await select();
    lease.commitSession(stable!);
    const pending = await select(['affinity-a']);
    expect(pending?.id).toBe('affinity-b');
    expect((await lease.getNextToken({ model: 'gemini-3-flash' }))?.id).toBe('affinity-a');
    lease.commitSession(pending!);
    expect((await lease.getNextToken({ model: 'gemini-3-flash' }))?.id).toBe('affinity-b');
  });

  it.each(['clear', 'deleted-and-reloaded', 'disabled', 'validation'] as const)(
    'refuses stale success after %s',
    async (action) => {
      const { lease, select } = await fixture();
      const pending = await select();
      if (action === 'clear') {
        lease.clearAllSessions();
      }
      if (action === 'deleted-and-reloaded') {
        lease.evictAccount('affinity-a');
        await lease.loadAccounts();
      }
      if (action === 'disabled') {
        lease.updateAccountOAuthHealth('affinity-a', { refresh_blocked: true });
      }
      if (action === 'validation') {
        await lease.markValidationRequired({ accountId: 'affinity-a' });
      }
      lease.commitSession(pending!);
      lease.updateAccountOAuthHealth('affinity-a', { refresh_blocked: false });
      expect((await select())?.id).toBe('affinity-b');
    },
  );
});
