import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountLeaseService } from '@/server/gateway/modules/account-lease/account-lease.service';
import type {
  AccountLeaseAccountStore,
  AccountLeaseUpstream,
} from '@/server/gateway/modules/account-lease/interfaces/account-lease-adapters';
import { DEFAULT_APP_CONFIG } from '@/modules/config/types';
import { getServerConfig, setServerConfig } from '@/server/server-config';
import { createAccount } from './proxy-real-path.harness';

const previous = getServerConfig() ?? DEFAULT_APP_CONFIG.proxy;
const services: AccountLeaseService[] = [];
async function fixture() {
  setServerConfig({ ...DEFAULT_APP_CONFIG.proxy, quota_aware_scheduling_enabled: false });
  const account = createAccount('project-service-account');
  account.token.project_id = undefined;
  const store: AccountLeaseAccountStore = {
    getAccounts: vi.fn(async () => [structuredClone(account)]),
    getAccount: vi.fn(async () => structuredClone(account)),
    async compareAndUpdateToken(id, _expected, token, guard) {
      await this.updateToken(id, token, guard);
      return true;
    },
    updateToken: vi.fn(async (_id, token, guard) => {
      guard?.(structuredClone(account));
      account.token = structuredClone(token);
    }),
    updateQuota: vi.fn(),
    mutateHealth: vi.fn(),
  };
  const upstream: AccountLeaseUpstream = {
    fetchProjectId: vi.fn(),
    fetchQuota: vi.fn(),
    refreshAccessToken: vi.fn(),
    normalizeRefreshedOAuthClientKey: vi.fn(),
  };
  const service = new AccountLeaseService(store, upstream);
  services.push(service);
  await service.loadAccounts();
  const select = () => service.getNextToken({ model: 'gemini-3-flash' });
  return { account, store, upstream, service, select };
}
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(0);
});
afterEach(async () => {
  for (const service of services.splice(0)) {
    await service.onModuleDestroy();
  }
  setServerConfig(previous);
  vi.useRealTimers();
});

describe('project cache lifecycle through AccountLeaseService', () => {
  it('uses fallback without persistence during the failure TTL and recovers at expiry', async () => {
    const { upstream, store, service, select } = await fixture();
    vi.mocked(upstream.fetchProjectId)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce('resolved-service-project');
    const first = await select();
    expect(first?.token.project_id).toBeTruthy();
    vi.setSystemTime(299_999);
    expect((await select())?.token.project_id).toBe(first?.token.project_id);
    expect(upstream.fetchProjectId).toHaveBeenCalledOnce();
    expect(store.updateToken).not.toHaveBeenCalled();
    vi.setSystemTime(300_000);
    expect((await select())?.token.project_id).toBe('resolved-service-project');
    await service.onModuleDestroy();
    expect(
      vi.mocked(store.updateToken).mock.calls.map(([, updated]) => updated.project_id),
    ).toEqual(['resolved-service-project']);
  });

  it('invalidates failure on explicit account reload', async () => {
    const { upstream, service, select } = await fixture();
    vi.mocked(upstream.fetchProjectId)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce('reloaded-project');
    await select();
    await service.reloadAllAccountsOrThrow();
    expect((await select())?.token.project_id).toBe('reloaded-project');
    expect(upstream.fetchProjectId).toHaveBeenCalledTimes(2);
  });

  it('keeps a replacement account independent of a deleted in-flight probe', async () => {
    const { account, upstream, store, service, select } = await fixture();
    const pending = Promise.withResolvers<string | null>();
    const arrived = Promise.withResolvers<void>();
    vi.mocked(upstream.fetchProjectId)
      .mockImplementationOnce(() => {
        arrived.resolve();
        return pending.promise;
      })
      .mockResolvedValueOnce('replacement-service-project');
    const old = select();
    await arrived.promise;
    expect(service.evictAccount(account.id)).toBe(true);
    account.token.refresh_token = 'replacement-synthetic-refresh';
    await service.loadAccounts();
    expect((await select())?.token.project_id).toBe('replacement-service-project');
    pending.resolve('obsolete-service-project');
    await old;
    expect(service.getAccountCount()).toBe(1);
    expect((await select())?.token.project_id).toBe('replacement-service-project');
    await service.onModuleDestroy();
    expect(
      vi.mocked(store.updateToken).mock.calls.map(([, updated]) => updated.project_id),
    ).toEqual(['replacement-service-project']);
  });

  it('propagates the project persistence guard through the real service callback', async () => {
    const { account, upstream, store, service, select } = await fixture();
    const read =
      Promise.withResolvers<Awaited<ReturnType<AccountLeaseAccountStore['getAccount']>>>();
    const arrived = Promise.withResolvers<void>();
    vi.mocked(upstream.fetchProjectId).mockResolvedValue('obsolete-project');
    vi.mocked(store.getAccount)
      .mockResolvedValueOnce(structuredClone(account))
      .mockImplementationOnce(() => {
        arrived.resolve();
        return read.promise;
      });
    await select();
    await arrived.promise;
    service.evictAccount(account.id);
    account.token.refresh_token = 'replacement-synthetic-refresh';
    const reloading = service.loadAccounts();
    read.resolve(structuredClone(account));
    await reloading;
    await service.onModuleDestroy();
    expect(store.updateToken).not.toHaveBeenCalled();
  });
});
