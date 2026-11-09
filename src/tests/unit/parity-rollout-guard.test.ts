import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_APP_CONFIG, ProxyConfig } from '@/modules/config/types';
import { setServerConfig } from '../../server/server-config';
import { AccountLeaseService } from '../../modules/proxy-gateway/server/modules/account-lease/account-lease.service';
import { accountLeaseStoreFixture, leaseAccount } from '../support/account-lease-store-fixture';

function createProxyConfig(overrides: Partial<ProxyConfig>): ProxyConfig {
  return {
    ...DEFAULT_APP_CONFIG.proxy,
    ...overrides,
    upstream_proxy: {
      ...DEFAULT_APP_CONFIG.proxy.upstream_proxy,
      ...(overrides.upstream_proxy ?? {}),
    },
  };
}

describe('Parity rollout guard replay', () => {
  let service: AccountLeaseService;

  beforeEach(async () => {
    const { store } = accountLeaseStoreFixture([leaseAccount('acc-1'), leaseAccount('acc-2')]);
    service = new AccountLeaseService(store, undefined, undefined, undefined, undefined, null);
    await service.loadAccounts();
  });

  afterEach(async () => {
    await service.onModuleDestroy();
    setServerConfig(DEFAULT_APP_CONFIG.proxy);
  });

  it('supports kill-switch rollback from parity path to baseline path', async () => {
    setServerConfig(
      createProxyConfig({
        parity_enabled: true,
        parity_kill_switch: false,
        preferred_account_id: 'acc-2',
      }),
    );
    const paritySelected = await service.getNextToken({ model: 'gemini-2.5-flash' });
    expect(paritySelected?.id).toBe('acc-2');

    setServerConfig(
      createProxyConfig({
        parity_enabled: true,
        parity_kill_switch: true,
        preferred_account_id: 'acc-2',
      }),
    );
    service.resetSelectionState();
    const rollbackSelected = await service.getNextToken({ model: 'gemini-2.5-flash' });
    expect(rollbackSelected?.id).toBe('acc-1');
    // Verify that shadow comparison was bypassed due to kill-switch
    expect((service as any).shadowComparisonCount).toBe(0);
  });

  it('enforces no-go threshold after shadow mismatch and blocks parity enablement', async () => {
    setServerConfig(
      createProxyConfig({
        parity_enabled: false,
        parity_shadow_enabled: true,
        parity_no_go_mismatch_rate: 0,
        preferred_account_id: 'acc-2',
      }),
    );

    const shadowSelection = await service.getNextToken({ model: 'gemini-2.5-flash' });
    expect(shadowSelection?.id).toBe('acc-1');

    setServerConfig(
      createProxyConfig({
        parity_enabled: true,
        parity_shadow_enabled: false,
        parity_kill_switch: false,
        preferred_account_id: 'acc-2',
      }),
    );
    service.resetSelectionState();
    const blockedSelection = await service.getNextToken({ model: 'gemini-2.5-flash' });
    expect(blockedSelection?.id).toBe('acc-1');
    expect((service as any).noGoBlocked).toBe(true);
  });
});
