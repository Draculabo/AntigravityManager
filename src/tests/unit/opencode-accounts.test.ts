import { describe, expect, it } from 'vitest';
import { buildOpenCodeAccountsFile } from '@/modules/proxy-gateway/opencode-sync/opencode-accounts';

describe('OpenCode account synchronization', () => {
  it('preserves plugin state by refresh token before falling back to email', () => {
    const existing = JSON.stringify({
      version: 3,
      accounts: [
        {
          email: 'old-primary@example.com',
          refreshToken: 'refresh-primary',
          projectId: 'old-project',
          addedAt: 100,
          lastUsed: 200,
          rateLimitResetTimes: { claude: 300 },
          managedProjectId: '',
          enabled: false,
          lastSwitchReason: '',
          coolingDownUntil: 400,
          cooldownReason: '',
          fingerprint: { id: 'fingerprint' },
          cachedQuota: { remaining: 0.5 },
          cachedQuotaUpdatedAt: 500,
          fingerprintHistory: [{ id: 'old' }],
        },
        {
          email: 'email-fallback@example.com',
          refreshToken: 'old-email-token',
          addedAt: 600,
          lastUsed: 700,
          enabled: null,
          fingerprint: null,
        },
      ],
      activeIndex: 8,
      activeIndexByFamily: { claude: -2, custom: 9, invalid: 'skip-me' },
    });

    const result = buildOpenCodeAccountsFile(
      existing,
      [
        {
          email: 'renamed@example.com',
          refreshToken: 'refresh-primary',
          projectId: 'new-project',
          lastUsed: 250,
        },
        {
          email: 'email-fallback@example.com',
          refreshToken: 'new-email-token',
          lastUsed: 650,
        },
      ],
      () => 999,
    );

    expect(result).toEqual({
      version: 3,
      accounts: [
        {
          email: 'renamed@example.com',
          refreshToken: 'refresh-primary',
          projectId: 'new-project',
          addedAt: 100,
          lastUsed: 250,
          rateLimitResetTimes: { claude: 300 },
          managedProjectId: '',
          enabled: false,
          lastSwitchReason: '',
          coolingDownUntil: 400,
          cooldownReason: '',
          fingerprint: { id: 'fingerprint' },
          cachedQuota: { remaining: 0.5 },
          cachedQuotaUpdatedAt: 500,
          fingerprintHistory: [{ id: 'old' }],
        },
        {
          email: 'email-fallback@example.com',
          refreshToken: 'new-email-token',
          addedAt: 600,
          lastUsed: 700,
        },
      ],
      activeIndex: 1,
      activeIndexByFamily: { claude: 0, custom: 1, gemini: 1 },
    });
  });

  it('creates schema v3 defaults and skips disabled accounts', () => {
    const result = buildOpenCodeAccountsFile(
      '{ invalid',
      [
        {
          email: 'active@example.com',
          refreshToken: 'active-refresh',
          lastUsed: 123,
        },
        {
          email: 'disabled@example.com',
          refreshToken: 'disabled-refresh',
          lastUsed: 456,
          disabled: true,
        },
        {
          email: 'proxy-disabled@example.com',
          refreshToken: 'proxy-disabled-refresh',
          lastUsed: 789,
          proxyDisabled: true,
        },
      ],
      () => 1_000,
    );

    expect(result).toEqual({
      version: 3,
      accounts: [
        {
          email: 'active@example.com',
          refreshToken: 'active-refresh',
          addedAt: 1_000,
          lastUsed: 123,
        },
      ],
      activeIndex: 0,
      activeIndexByFamily: { claude: 0, gemini: 0 },
    });
  });
});
