import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CloudAccountRepo } from '@/modules/cloud-account/persistence/cloudHandler';
import { GoogleAPIService } from '@/modules/cloud-account/services/GoogleAPIService';
import { CloudAccountRefreshService } from '@/modules/cloud-account/services/CloudAccountRefreshService';
import { refreshAccountQuotaCore } from '@/modules/cloud-account/services/cloud-account-quota-refresh.service';
import { CloudMonitorService } from '@/modules/cloud-account/services/CloudMonitorService';
import type { CloudAccount } from '@/modules/cloud-account/types';

vi.mock('@/modules/cloud-account/persistence/cloudHandler');
vi.mock('@/modules/cloud-account/services/GoogleAPIService');
vi.mock('@/modules/cloud-account/services/CloudAccountRefreshService', async (original) => ({
  ...(await original<
    typeof import('@/modules/cloud-account/services/CloudAccountRefreshService')
  >()),
  CloudAccountRefreshService: { refreshAccessToken: vi.fn() },
}));
vi.mock('@/modules/cloud-account/services/CloudAccountHealthService', () => ({
  clearValidationHealthAfterSuccessfulProbe: vi.fn(),
}));
vi.mock('@/modules/cloud-account/persistence/cloud-account-settings-store', () => ({
  CloudAccountSettingsStore: {
    getSetting: (_key: string, fallback: unknown) => fallback,
    readSetting: () => undefined,
  },
}));
vi.mock('@/shared/platform/paths', async (original) => ({
  ...(await original<typeof import('@/shared/platform/paths')>()),
  getAntigravityStoragePaths: () => [],
}));
vi.mock('@/modules/antigravity-runtime/binary-patch/agyCliPathDetection', () => ({
  detectAgyCliExecutablePath: () => null,
}));
vi.mock('@/modules/config/ipc/manager', () => ({
  ConfigManager: { getCachedConfig: () => ({}), loadConfig: () => ({}) },
}));

const stored = new Map<string, CloudAccount>();
const quota = { models: { gemini: { percentage: 80, resetTime: '' } } };
function account(id = 'a'): CloudAccount {
  return {
    id,
    provider: 'google',
    email: `${id}@example.com`,
    created_at: 1,
    last_used: 1,
    token: {
      access_token: `access-${id}`,
      refresh_token: `grant-${id}`,
      token_type: 'Bearer',
      expires_in: 3600,
      expiry_timestamp: Date.now() / 1000 + 7200,
    },
    quota: { models: { gemini: { percentage: 10, resetTime: '' } } },
    status: 'active',
  };
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.resetAllMocks();
  stored.clear();
  stored.set('a', account());
  CloudMonitorService.resetStateForTesting();
  CloudMonitorService.configureEffects({ onQuotaUpdated: vi.fn() });
  vi.mocked(CloudAccountRepo.getAccount).mockImplementation(async (id) => {
    const current = stored.get(id);
    return current ? structuredClone(current) : undefined;
  });
  vi.mocked(CloudAccountRepo.getAccounts).mockImplementation(async () =>
    [...stored.values()].map((value) => structuredClone(value)),
  );
  vi.mocked(CloudAccountRepo.updateToken).mockImplementation(async (id, token, guard) => {
    guard?.(stored.get(id));
    const current = stored.get(id);
    if (current) {
      current.token = structuredClone(token);
    }
  });
  vi.mocked(CloudAccountRepo.updateQuota).mockImplementation(async (id, value, guard) => {
    guard?.(stored.get(id));
    const current = stored.get(id);
    if (current) {
      current.quota = structuredClone(value);
    }
  });
  vi.mocked(CloudAccountRepo.setAccountStatus).mockImplementation(
    async (id, status, reason, guard) => {
      guard?.(stored.get(id));
      const current = stored.get(id);
      if (current) {
        current.status = status;
        current.status_reason = reason ?? undefined;
      }
    },
  );
  vi.mocked(CloudAccountRepo.updateLastUsed).mockImplementation((id, guard) => {
    guard?.(stored.get(id));
  });
  vi.mocked(GoogleAPIService.fetchAICredits).mockResolvedValue(null);
  vi.mocked(GoogleAPIService.normalizeRefreshedOAuthClientKey).mockImplementation(
    (token) => token.oauth_client_key,
  );
});
afterEach(async () => {
  CloudMonitorService.closeAdmission();
  await CloudMonitorService.drain();
  vi.useRealTimers();
});

describe('manual quota refresh context', () => {
  it('rejects a token refresh result for a replaced account without reporting login expiry', async () => {
    const original = stored.get('a');
    if (!original) {
      throw new Error('Missing fixture account');
    }
    original.token.expiry_timestamp = 0;
    vi.mocked(CloudAccountRefreshService.refreshAccessToken).mockImplementation(async () => {
      const replacement = account();
      replacement.token.refresh_token = 'replacement';
      stored.set('a', replacement);
      return { access_token: 'obsolete-access', expires_in: 3600, token_type: 'Bearer' };
    });
    await expect(refreshAccountQuotaCore('a')).rejects.toMatchObject({
      name: 'CloudAccountRefreshContextChangedError',
    });
    expect(stored.get('a')?.token.refresh_token).toBe('replacement');
    expect(CloudAccountRepo.setAccountStatus).not.toHaveBeenCalled();
    expect(GoogleAPIService.fetchQuota).not.toHaveBeenCalled();
  });

  it.each(['deleted', 'grant', 'access', 'proxy'] as const)(
    'discards success after context is %s',
    async (change) => {
      const onPrimarySuccess = vi.fn();
      vi.mocked(GoogleAPIService.fetchQuota).mockImplementation(async () => {
        if (change === 'deleted') {
          stored.delete('a');
        } else {
          const replacement = account();
          if (change === 'grant') {
            replacement.token.refresh_token = 'replacement';
          }
          if (change === 'access') {
            replacement.token.access_token = 'replacement';
          }
          if (change === 'proxy') {
            replacement.proxy_url = 'http://127.0.0.1:18080';
          }
          stored.set('a', replacement);
        }
        return quota;
      });
      await expect(refreshAccountQuotaCore('a', { onPrimarySuccess })).rejects.toMatchObject({
        name: 'CloudAccountRefreshContextChangedError',
      });
      expect(CloudAccountRepo.updateQuota).not.toHaveBeenCalled();
      expect(CloudAccountRepo.setAccountStatus).not.toHaveBeenCalled();
      expect(GoogleAPIService.fetchAICredits).not.toHaveBeenCalled();
      expect(onPrimarySuccess).not.toHaveBeenCalled();
    },
  );

  it.each(['FORBIDDEN', 'RESOURCE_EXHAUSTED', 'UNAUTHORIZED'])(
    'does not apply a late %s failure to a replacement',
    async (message) => {
      const primary = new Error(message);
      vi.mocked(GoogleAPIService.fetchQuota).mockImplementation(async () => {
        const replacement = account();
        replacement.token.refresh_token = 'replacement';
        stored.set('a', replacement);
        throw primary;
      });
      await expect(refreshAccountQuotaCore('a')).rejects.toMatchObject({
        name: 'CloudAccountRefreshContextChangedError',
      });
      expect(CloudAccountRepo.setAccountStatus).not.toHaveBeenCalled();
      expect(CloudAccountRefreshService.refreshAccessToken).not.toHaveBeenCalled();
      expect(stored.get('a')?.status).toBe('active');
    },
  );

  it('advances only its own refreshed credential context before writing retried quota', async () => {
    vi.mocked(GoogleAPIService.fetchQuota)
      .mockRejectedValueOnce(new Error('UNAUTHORIZED'))
      .mockResolvedValueOnce(quota);
    vi.mocked(CloudAccountRefreshService.refreshAccessToken).mockResolvedValue({
      access_token: 'new-access',
      refresh_token: 'new-grant',
      expires_in: 3600,
      token_type: 'Bearer',
    });
    const result = await refreshAccountQuotaCore('a');
    expect(result.quota).toEqual(quota);
    expect(stored.get('a')?.token.refresh_token).toBe('new-grant');
    expect(stored.get('a')?.quota).toEqual(quota);
  });

  it('rejects a deletion during credits without clearing status or publishing success', async () => {
    vi.mocked(GoogleAPIService.fetchQuota).mockResolvedValue(quota);
    vi.mocked(GoogleAPIService.fetchAICredits).mockImplementation(async () => {
      stored.delete('a');
      return null;
    });
    const onPrimarySuccess = vi.fn();
    await expect(refreshAccountQuotaCore('a', { onPrimarySuccess })).rejects.toMatchObject({
      name: 'CloudAccountRefreshContextChangedError',
    });
    expect(stored.has('a')).toBe(false);
    expect(CloudAccountRepo.setAccountStatus).not.toHaveBeenCalled();
    expect(onPrimarySuccess).not.toHaveBeenCalled();
  });
});

describe('monitor refresh context', () => {
  it('omits an account replaced during an unclassified token refresh failure and continues the next account', async () => {
    const first = stored.get('a');
    if (!first) {
      throw new Error('Missing fixture account');
    }
    first.token.expiry_timestamp = 0;
    stored.set('b', account('b'));
    const onQuotaUpdated = vi.fn();
    CloudMonitorService.configureEffects({ onQuotaUpdated });
    vi.mocked(CloudAccountRefreshService.refreshAccessToken).mockImplementation(async () => {
      const replacement = account();
      replacement.token.refresh_token = 'replacement';
      stored.set('a', replacement);
      throw new Error('Synthetic transport failure');
    });
    vi.mocked(GoogleAPIService.fetchQuota).mockResolvedValue(quota);
    const pending = CloudMonitorService.poll();
    await vi.advanceTimersByTimeAsync(1000);
    await pending;
    expect(stored.get('a')?.status).toBe('active');
    expect(vi.mocked(CloudAccountRepo.updateQuota).mock.calls.map(([id]) => id)).toEqual(['b']);
    expect(onQuotaUpdated).toHaveBeenCalledExactlyOnceWith([
      expect.objectContaining({ id: 'b', quota }),
    ]);
  });

  it.each(['success', 'FORBIDDEN', 'RESOURCE_EXHAUSTED'] as const)(
    'skips stale %s for A and continues B',
    async (outcome) => {
      stored.set('b', account('b'));
      const onQuotaUpdated = vi.fn();
      CloudMonitorService.configureEffects({ onQuotaUpdated });
      vi.mocked(GoogleAPIService.fetchQuota).mockImplementation(async (access) => {
        if (access === 'access-a') {
          const replacement = account();
          replacement.token.refresh_token = 'replacement';
          stored.set('a', replacement);
          if (outcome !== 'success') {
            throw new Error(outcome);
          }
        }
        return quota;
      });
      const pending = CloudMonitorService.poll();
      await vi.advanceTimersByTimeAsync(2000);
      await pending;
      expect(stored.get('a')).toEqual(
        expect.objectContaining({ status: 'active', quota: account().quota }),
      );
      expect(stored.get('b')?.quota).toEqual(quota);
      expect(vi.mocked(CloudAccountRepo.updateQuota).mock.calls.map(([id]) => id)).toEqual(['b']);
      expect(onQuotaUpdated).toHaveBeenCalledExactlyOnceWith([
        expect.objectContaining({ id: 'b', quota }),
      ]);
    },
  );
});
