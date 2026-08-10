import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_APP_CONFIG, type ProxyConfig } from '@/modules/config/types';
import { AccountLeaseConfigPolicy } from '@/modules/proxy-gateway/server/modules/account-lease/policies/account-lease-config.policy';
import { setServerConfig } from '../../server/server-config';

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

describe('AccountLeaseConfigPolicy', () => {
  afterEach(() => {
    delete process.env.PROXY_FALLBACK_PROJECT_ID;
  });

  it('normalizes selection config from server config', () => {
    setServerConfig(
      createProxyConfig({
        parity_enabled: true,
        parity_kill_switch: false,
        parity_shadow_enabled: true,
        scheduling_mode: 'performance-first',
        preferred_account_id: ' acc-1 ',
        max_wait_seconds: 12,
        parity_no_go_mismatch_rate: 2,
        parity_no_go_error_rate: -1,
      }),
    );

    const policy = new AccountLeaseConfigPolicy();

    expect(policy.getSelectionConfig()).toEqual({
      parityEnabled: true,
      parityShadowEnabled: true,
      schedulingMode: 'performance-first',
      preferredAccountId: 'acc-1',
      maxWaitMs: 12_000,
      noGoMismatchRateThreshold: 1,
      noGoErrorRateThreshold: 0,
    });
  });

  it('falls back to balance mode and default backoff when config values are invalid', () => {
    setServerConfig(
      createProxyConfig({
        scheduling_mode: 'unknown-mode' as ProxyConfig['scheduling_mode'],
        circuit_breaker_backoff_steps: [0, -1, Number.NaN],
      }),
    );

    const policy = new AccountLeaseConfigPolicy();

    expect(policy.getSelectionConfig().schedulingMode).toBe('balance');
    expect(policy.getCircuitBreakerBackoffSteps()).toEqual([60, 300, 1800, 7200]);
  });

  it('uses a normalized fallback project id from env when provided', () => {
    process.env.PROXY_FALLBACK_PROJECT_ID = ' custom-project ';

    const policy = new AccountLeaseConfigPolicy();

    expect(policy.resolveFallbackProjectId()).toBe('custom-project');
  });
});
