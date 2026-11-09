import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CloudAccountRepo } from '@/modules/cloud-account/persistence/cloudHandler';
import { OAuthRecoveryJournal } from '@/modules/cloud-account/persistence/oauth-recovery-journal';
import {
  isAccountOAuthRecoveryBlocked,
  OAuthRecoveryPendingError,
  recoverOAuthJournal,
} from '@/modules/cloud-account/persistence/oauth-recovery-service';
import { CloudAccountRefreshService } from '@/modules/cloud-account/services/CloudAccountRefreshService';
import { refreshAccountQuotaCore } from '@/modules/cloud-account/services/cloud-account-quota-refresh.service';
import { CloudMonitorService } from '@/modules/cloud-account/services/CloudMonitorService';
import { GoogleAPIService } from '@/modules/cloud-account/services/GoogleAPIService';
import { AutoSwitchService } from '@/modules/cloud-account/services/AutoSwitchService';
import { AccountLeaseService } from '@/modules/proxy-gateway/server/modules/account-lease/account-lease.service';
import { CoreService, type CoreDependencies } from '@/core/core-service';
import { DEFAULT_APP_CONFIG } from '@/modules/config/types';
import type { CloudAccount } from '@/modules/cloud-account/types';
import * as security from '@/shared/security/security';
import {
  decryptParsedPayloadWithKey,
  encryptWithKey,
  parseEncryptedPayload,
} from '@/shared/security/crypto';

const state = vi.hoisted(() => ({ directory: '' }));
vi.mock('better-sqlite3', async () => {
  const { createRequire } = await import('node:module');
  return { default: createRequire(import.meta.url)('better-sqlite3') };
});
vi.mock('@/shared/platform/paths', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/shared/platform/paths')>()),
  getCloudAccountsDbPath: () => path.join(state.directory, 'cloud_accounts.db'),
}));

function account(id: string): CloudAccount {
  return {
    id,
    provider: 'google',
    status: 'active',
    email: `${id}@example.com`,
    token: {
      access_token: `${id}-access`,
      refresh_token: `${id}-refresh`,
      expires_in: 3600,
      expiry_timestamp: Math.floor(Date.now() / 1000) + 3600,
      token_type: 'Bearer',
      project_id: 'test-project',
    },
    quota: { models: { 'gemini-3-flash': { percentage: 100, resetTime: '' } } },
    created_at: 1,
    last_used: 1,
  };
}

beforeEach(async () => {
  state.directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agm-recovery-isolation-'));
  const key = Buffer.alloc(32, 9);
  vi.spyOn(security, 'initializeMasterKey').mockResolvedValue({ state: 'secure' });
  vi.spyOn(security, 'encrypt').mockImplementation(async (value) => encryptWithKey(key, value));
  vi.spyOn(security, 'decrypt').mockImplementation(async (value) => {
    const payload = parseEncryptedPayload(value);
    if (!payload) {
      throw new Error('Invalid encrypted data');
    }
    return decryptParsedPayloadWithKey(key, payload);
  });
  CloudMonitorService.resetStateForTesting();
  await CloudAccountRepo.init();
});

afterEach(async () => {
  CloudMonitorService.stop();
  await CloudMonitorService.drain();
  vi.restoreAllMocks();
  await fs.rm(state.directory, { recursive: true, force: true });
});

async function conflictFixture() {
  const original = account('conflict');
  const healthy = account('healthy');
  await CloudAccountRepo.addAccount(original);
  await CloudAccountRepo.addAccount(healthy);
  const directory = path.join(state.directory, 'oauth-recovery');
  const journal = new OAuthRecoveryJournal(directory);
  const name = await journal.append({
    version: 1,
    accountId: original.id,
    expected: {
      access_token: original.token.access_token,
      refresh_token: original.token.refresh_token,
    },
    token: { ...original.token, access_token: 'rotated-access', refresh_token: 'rotated-refresh' },
  });
  const retainedName = '00000000-0000-4000-8000-000000000000.recovery';
  await fs.rename(path.join(directory, name), path.join(directory, retainedName));
  const ciphertext = await fs.readFile(path.join(directory, retainedName), 'utf8');
  const replacement = {
    ...original.token,
    access_token: 'reauth-access',
    refresh_token: 'reauth-refresh',
  };
  await CloudAccountRepo.updateToken(original.id, replacement);
  return { original, healthy, journal, directory, retainedName, ciphertext, replacement };
}

describe('account-local OAuth recovery', () => {
  it('starts the core, preserves conflicts and recovers healthy accounts after them', async () => {
    const fixture = await conflictFixture();
    const healthyToken = { ...fixture.healthy.token, access_token: 'healthy-rotated-access' };
    await fixture.journal.append({
      version: 1,
      accountId: fixture.healthy.id,
      expected: {
        access_token: fixture.healthy.token.access_token,
        refresh_token: fixture.healthy.token.refresh_token,
      },
      token: healthyToken,
    });
    const lease = new AccountLeaseService();
    const dependencies: CoreDependencies = {
      enableFileLogging: vi.fn(),
      loadConfig: () => ({
        ...DEFAULT_APP_CONFIG,
        proxy: { ...DEFAULT_APP_CONFIG.proxy, auto_start: true },
      }),
      initializeAccounts: () => CloudAccountRepo.init(),
      initializeLocalDatabase: vi.fn(),
      startGateway: async () => {
        expect(await lease.loadAccounts()).toBe(1);
        return { success: true, port: 8045, base_url: 'http://127.0.0.1:8045' };
      },
      startGatewayOnPort: vi.fn(),
      stopGateway: async () => {
        await lease.onModuleDestroy();
        return true;
      },
      getGatewayStatus: vi.fn(),
    };
    const core = new CoreService(dependencies);
    try {
      await core.start();
      expect(core.getStatus().state).toBe('running');
      expect((await CloudAccountRepo.getAccounts()).map((entry) => entry.id).sort()).toEqual([
        'conflict',
        'healthy',
      ]);
      expect((await CloudAccountRepo.getAccount(fixture.original.id))?.token).toEqual(
        fixture.replacement,
      );
      expect((await CloudAccountRepo.getAccount(fixture.healthy.id))?.token).toEqual(healthyToken);
      expect(await lease.getNextToken({ targetAccountId: fixture.original.id })).toBeNull();
      expect((await lease.getNextToken({ targetAccountId: fixture.healthy.id }))?.id).toBe(
        fixture.healthy.id,
      );
      expect(await lease.reloadAllAccountsOrThrow()).toBe(1);
      expect((await AutoSwitchService.findBestAccount('current'))?.id).toBe(fixture.healthy.id);
      expect(await lease.getNextToken({ targetAccountId: fixture.original.id })).toBeNull();
      await expect(
        lease.getNextImageToken({ targetAccountId: fixture.original.id }),
      ).rejects.toThrow('No available image accounts');
      expect(await fs.readFile(path.join(fixture.directory, fixture.retainedName), 'utf8')).toBe(
        fixture.ciphertext,
      );
      expect((await fixture.journal.readAll()).map((entry) => entry.name)).toEqual([
        fixture.retainedName,
      ]);
    } finally {
      await core.stop();
    }
  });

  it('prevents quota, token refresh and monitoring calls for unresolved credentials', async () => {
    const fixture = await conflictFixture();
    await CloudAccountRepo.removeAccount(fixture.healthy.id);
    await CloudAccountRepo.init();
    expect(await AutoSwitchService.findBestAccount('current')).toBeNull();
    const quota = vi.spyOn(GoogleAPIService, 'fetchQuota');
    const credits = vi.spyOn(GoogleAPIService, 'fetchAICredits');
    const refresh = vi.spyOn(GoogleAPIService, 'refreshAccessToken');
    await expect(refreshAccountQuotaCore(fixture.original.id)).rejects.toBeInstanceOf(
      OAuthRecoveryPendingError,
    );
    await expect(
      CloudAccountRefreshService.refreshAccessToken({
        accountId: fixture.original.id,
        refreshToken: fixture.replacement.refresh_token,
      }),
    ).rejects.toBeInstanceOf(OAuthRecoveryPendingError);
    await CloudMonitorService.poll();
    expect(quota).not.toHaveBeenCalled();
    expect(credits).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it('isolates profiles and clears a block only after a successful rescan', async () => {
    const fixture = await conflictFixture();
    await recoverOAuthJournal(fixture.journal);
    expect(isAccountOAuthRecoveryBlocked(fixture.original.id)).toBe(true);
    const otherProfile = new OAuthRecoveryJournal(path.join(state.directory, 'other-profile'));
    await recoverOAuthJournal(otherProfile);
    expect(isAccountOAuthRecoveryBlocked(fixture.original.id, otherProfile)).toBe(false);
    const read = vi
      .spyOn(fixture.journal, 'readAll')
      .mockRejectedValueOnce(new Error('unreadable'));
    await expect(recoverOAuthJournal(fixture.journal)).rejects.toThrow('unreadable');
    expect(isAccountOAuthRecoveryBlocked(fixture.original.id)).toBe(true);
    read.mockRestore();
    await fixture.journal.remove(fixture.retainedName);
    await recoverOAuthJournal(fixture.journal);
    expect(isAccountOAuthRecoveryBlocked(fixture.original.id)).toBe(false);
    expect((await CloudAccountRepo.getAccount(fixture.original.id))?.token).toEqual(
      fixture.replacement,
    );
  });
});
