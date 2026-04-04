import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_APP_CONFIG, ProxyConfig } from '../../types/config';
import { setServerConfig } from '../../server/server-config';
import { TokenManagerService } from '../../server/modules/proxy/token-manager.service';

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

function seedTokens(service: TokenManagerService): void {
  const nowSec = Math.floor(Date.now() / 1000);
  (service as any).tokens = new Map([
    [
      'acc-1',
      {
        account_id: 'acc-1',
        email: 'acc-1@test.dev',
        access_token: 'token-1',
        refresh_token: 'refresh-1',
        token_type: 'Bearer',
        expires_in: 3600,
        expiry_timestamp: nowSec + 3600,
        project_id: 'project-1',
      },
    ],
    [
      'acc-2',
      {
        account_id: 'acc-2',
        email: 'acc-2@test.dev',
        access_token: 'token-2',
        refresh_token: 'refresh-2',
        token_type: 'Bearer',
        expires_in: 3600,
        expiry_timestamp: nowSec + 3600,
        project_id: 'project-2',
      },
    ],
  ]);
}

describe('Parity rollout guard replay', () => {
  let service: TokenManagerService;

  beforeEach(() => {
    service = new TokenManagerService();
    seedTokens(service);
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
