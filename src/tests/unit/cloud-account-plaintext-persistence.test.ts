import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CloudAccountRepo } from '@/modules/cloud-account/persistence/cloudHandler';
import { applyOAuthRecoveryRecord } from '@/modules/cloud-account/persistence/oauth-recovery-apply';
import { OAuthRecoveryJournal } from '@/modules/cloud-account/persistence/oauth-recovery-journal';
import { commitOAuthRecoveryRecord, recoverOAuthJournal } from '@/modules/cloud-account/persistence/oauth-recovery-service';
import { CloudAccountSettingsStore } from '@/modules/cloud-account/persistence/cloud-account-settings-store';
import { upsertCloudAccountsAtomically } from '@/modules/cloud-account/persistence/cloud-account-batch-writer';
import type { CloudAccount } from '@/modules/cloud-account/types';
import { AccountLeaseService } from '@/modules/proxy-gateway/server/modules/account-lease/account-lease.service';
import {
  cloudAccountStoreAdapter,
  type AccountLeaseUpstream,
} from '@/modules/proxy-gateway/server/modules/account-lease/interfaces/account-lease-adapters';
import * as security from '@/shared/security/security';
import {
  decryptParsedPayloadWithKey,
  ENCRYPTED_PAYLOAD_VERSION_PREFIX,
  encryptWithKey,
  parseEncryptedPayload,
} from '@/shared/security/crypto';

const state = vi.hoisted(() => ({ directory: '' }));
vi.mock('better-sqlite3', async () => {
  const { createRequire } = await import('node:module');
  return { default: createRequire(import.meta.url)('better-sqlite3') };
});
vi.mock('@/shared/platform/paths', () => ({
  getCloudAccountsDbPath: () => path.join(state.directory, 'cloud_accounts.db'),
}));

function account(): CloudAccount {
  return {
    id: 'account-one',
    provider: 'google',
    email: 'test@example.com',
    token: {
      access_token: 'access-one',
      refresh_token: 'refresh-one',
      expires_in: 3600,
      expiry_timestamp: 4102444800,
      token_type: 'Bearer',
    },
    quota: { models: {} },
    health: { oauth: { refresh_blocked: false } },
    created_at: 1700000000,
    last_used: 1700000001,
  };
}

beforeEach(() => {
  state.directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agm-plain-accounts-'));
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(state.directory, { recursive: true, force: true });
});

describe('plaintext cloud-account persistence', () => {
  it('bounds retries when conditional OAuth health writes keep conflicting', async () => {
    const first = account();
    await CloudAccountRepo.init();
    await CloudAccountRepo.addAccount(first);
    const compare = vi.spyOn(CloudAccountRepo, 'compareAndUpdateHealth').mockResolvedValue(false);
    const { CloudAccountHealthService } = await import('@/modules/cloud-account/services/CloudAccountHealthService');
    await expect(CloudAccountHealthService.mutateHealth(first.id, () => ({
      oauth: { refresh_blocked: false, invalid_grant_count: 1 },
    }), { expectedToken: first.token })).rejects.toThrow('Account health could not be updated');
    expect(compare).toHaveBeenCalledTimes(3);
    expect((await CloudAccountRepo.getAccount(first.id))?.health).toEqual(first.health);
  });
  it('retries OAuth health update after a concurrent project change', async () => {
    const first = account();
    await CloudAccountRepo.init();
    await CloudAccountRepo.addAccount(first);
    const compare = CloudAccountRepo.compareAndUpdateHealth.bind(CloudAccountRepo);
    vi.spyOn(CloudAccountRepo, 'compareAndUpdateHealth').mockImplementationOnce(async (...args) => {
      await CloudAccountRepo.updateToken(first.id, { ...first.token, project_id: 'new-project' });
      return compare(...args);
    });
    const { CloudAccountHealthService } = await import('@/modules/cloud-account/services/CloudAccountHealthService');
    await CloudAccountHealthService.mutateHealth(first.id, () => ({
      oauth: { refresh_blocked: false, invalid_grant_count: 1 },
    }), { expectedToken: first.token });
    const current = await CloudAccountRepo.getAccount(first.id);
    expect(current?.token.project_id).toBe('new-project');
    expect(current?.health?.oauth?.invalid_grant_count).toBe(1);
  });
  it('records OAuth health when only project metadata changed', async () => {
    const first = account();
    await CloudAccountRepo.init();
    await CloudAccountRepo.addAccount(first);
    await CloudAccountRepo.updateToken(first.id, { ...first.token, project_id: 'new-project' });
    const { CloudAccountHealthService } = await import('@/modules/cloud-account/services/CloudAccountHealthService');
    await CloudAccountHealthService.mutateHealth(first.id, () => ({
      oauth: { refresh_blocked: false, invalid_grant_count: 1 },
    }), { expectedToken: first.token });
    const current = await CloudAccountRepo.getAccount(first.id);
    expect(current?.token.project_id).toBe('new-project');
    expect(current?.health?.oauth?.invalid_grant_count).toBe(1);
  });
  it('rejects a health commit when reauthorization wins immediately before the SQLite compare', async () => {
    const first = account();
    await CloudAccountRepo.init();
    await CloudAccountRepo.addAccount(first);
    const replacement = { ...first.token, refresh_token: 'replacement-refresh' };
    const compare = CloudAccountRepo.compareAndUpdateHealth.bind(CloudAccountRepo);
    vi.spyOn(CloudAccountRepo, 'compareAndUpdateHealth').mockImplementationOnce(async (...args) => {
      await CloudAccountRepo.updateToken(first.id, replacement);
      return compare(...args);
    });
    const { CloudAccountHealthService } = await import('@/modules/cloud-account/services/CloudAccountHealthService');
    await expect(CloudAccountHealthService.mutateHealth(first.id, () => ({
      oauth: { refresh_blocked: true, invalid_grant_count: 2 },
    }), { expectedToken: first.token })).rejects.toThrow('Account credentials changed during health update');
    const current = await CloudAccountRepo.getAccount(first.id);
    expect(current?.token).toEqual(replacement);
    expect(current?.health).toEqual(first.health);
  });
  it('conditionally updates health only while token and health remain unchanged', async () => {
    const first = account();
    await CloudAccountRepo.init();
    await CloudAccountRepo.addAccount(first);
    const next = { oauth: { refresh_blocked: false, invalid_grant_count: 1 } };
    expect(await CloudAccountRepo.compareAndUpdateHealth(first.id, first.token, first.health, next)).toBe(true);
    const replacement = { ...first.token, refresh_token: 'replacement' };
    await CloudAccountRepo.updateToken(first.id, replacement);
    expect(await CloudAccountRepo.compareAndUpdateHealth(first.id, first.token, next, undefined)).toBe(false);
    expect((await CloudAccountRepo.getAccount(first.id))?.health).toEqual(next);
  });
  it('does not resurrect an account deleted during recovery commit', async () => {
    const first = account();
    await CloudAccountRepo.init();
    await CloudAccountRepo.addAccount(first);
    const record = {
      version: 1 as const,
      accountId: first.id,
      expected: { access_token: first.token.access_token, refresh_token: first.token.refresh_token },
      token: { ...first.token, access_token: 'rotated-access', refresh_token: 'rotated-refresh' },
    };
    const compare = CloudAccountRepo.compareAndUpdateToken.bind(CloudAccountRepo);
    vi.spyOn(CloudAccountRepo, 'compareAndUpdateToken').mockImplementationOnce(async (...args) => {
      await CloudAccountRepo.removeAccount(first.id);
      return compare(...args);
    });

    expect(await applyOAuthRecoveryRecord(record)).toBe('missing');
    expect(await CloudAccountRepo.getAccount(first.id)).toBeUndefined();
  });
  it('preserves concurrent project changes when replaying OAuth recovery', async () => {
    const first = account();
    first.token.project_id = 'old-project';
    await CloudAccountRepo.init();
    await CloudAccountRepo.addAccount(first);
    const record = {
      version: 1 as const,
      accountId: first.id,
      expected: { access_token: first.token.access_token, refresh_token: first.token.refresh_token },
      token: { ...first.token, access_token: 'rotated-access', refresh_token: 'rotated-refresh' },
    };
    const compare = CloudAccountRepo.compareAndUpdateToken.bind(CloudAccountRepo);
    vi.spyOn(CloudAccountRepo, 'compareAndUpdateToken').mockImplementationOnce(async (...args) => {
      await CloudAccountRepo.updateToken(first.id, { ...first.token, project_id: 'new-project' });
      return compare(...args);
    });

    expect(await applyOAuthRecoveryRecord(record)).toBe('applied');
    expect((await CloudAccountRepo.getAccount(first.id))?.token).toEqual({
      ...record.token,
      project_id: 'new-project',
    });
  });
  it('recovers a journal after cleanup fails following a journaled commit', async () => {
    const first = account();
    await CloudAccountRepo.init();
    await CloudAccountRepo.addAccount(first);
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
    const journal = new OAuthRecoveryJournal(path.join(state.directory, 'oauth-recovery'));
    const record = {
      version: 1 as const,
      accountId: first.id,
      expected: { access_token: first.token.access_token, refresh_token: first.token.refresh_token },
      token: { ...first.token, access_token: 'rotated-access', refresh_token: 'rotated-refresh' },
    };
    vi.spyOn(journal, 'remove').mockRejectedValueOnce(new Error('cleanup unavailable'));
    await expect(commitOAuthRecoveryRecord(journal, record)).rejects.toThrow('cleanup unavailable');
    expect((await CloudAccountRepo.getAccount(first.id))?.token).toEqual(record.token);
    expect(await journal.readAll()).toHaveLength(1);
    await CloudAccountRepo.init();
    expect((await CloudAccountRepo.getAccount(first.id))?.token).toEqual(record.token);
    expect(await journal.readAll()).toEqual([]);
  });
  it('does not mutate SQLite when journal persistence fails', async () => {
    const first = account();
    await CloudAccountRepo.init();
    await CloudAccountRepo.addAccount(first);
    const journal = new OAuthRecoveryJournal(path.join(state.directory, 'oauth-recovery'));
    vi.spyOn(journal, 'append').mockRejectedValueOnce(new Error('journal unavailable'));
    const compare = vi.spyOn(CloudAccountRepo, 'compareAndUpdateToken');
    const record = {
      version: 1 as const,
      accountId: first.id,
      expected: { access_token: first.token.access_token, refresh_token: first.token.refresh_token },
      token: { ...first.token, access_token: 'rotated-access', refresh_token: 'rotated-refresh' },
    };
    await expect(commitOAuthRecoveryRecord(journal, record)).rejects.toThrow('journal unavailable');
    expect(compare).not.toHaveBeenCalled();
    expect((await CloudAccountRepo.getAccount(first.id))?.token).toEqual(first.token);
  });
  it('preserves the journal and a concurrent reauthorization during journaled commit', async () => {
    const first = account();
    await CloudAccountRepo.init();
    await CloudAccountRepo.addAccount(first);
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
    const journal = new OAuthRecoveryJournal(path.join(state.directory, 'oauth-recovery'));
    const record = {
      version: 1 as const,
      accountId: first.id,
      expected: { access_token: first.token.access_token, refresh_token: first.token.refresh_token },
      token: { ...first.token, access_token: 'rotated-access', refresh_token: 'rotated-refresh' },
    };
    const replacement = { ...first.token, access_token: 'replacement-access', refresh_token: 'replacement-refresh' };
    const compare = CloudAccountRepo.compareAndUpdateToken.bind(CloudAccountRepo);
    vi.spyOn(CloudAccountRepo, 'compareAndUpdateToken').mockImplementationOnce(async (...args) => {
      await CloudAccountRepo.updateToken(first.id, replacement);
      return compare(...args);
    });

    await expect(commitOAuthRecoveryRecord(journal, record)).rejects.toThrow('manual resolution: conflict');
    expect((await CloudAccountRepo.getAccount(first.id))?.token).toEqual(replacement);
    expect((await journal.readAll()).map((entry) => entry.record)).toEqual([record]);
  });
  it('journals before committing a rotated token and preserves it when SQLite fails', async () => {
    const first = account();
    await CloudAccountRepo.init();
    await CloudAccountRepo.addAccount(first);
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
    const journal = new OAuthRecoveryJournal(path.join(state.directory, 'oauth-recovery'));
    const record = {
      version: 1 as const,
      accountId: first.id,
      expected: { access_token: first.token.access_token, refresh_token: first.token.refresh_token },
      token: { ...first.token, access_token: 'rotated-access', refresh_token: 'rotated-refresh' },
    };
    const compare = vi.spyOn(CloudAccountRepo, 'compareAndUpdateToken').mockRejectedValueOnce(new Error('SQLite unavailable'));
    await expect(commitOAuthRecoveryRecord(journal, record)).rejects.toThrow('SQLite unavailable');
    expect((await journal.readAll()).map((entry) => entry.record)).toEqual([record]);
    expect((await CloudAccountRepo.getAccount(first.id))?.token).toEqual(first.token);
    compare.mockRestore();
    await CloudAccountRepo.init();
    expect((await CloudAccountRepo.getAccount(first.id))?.token.refresh_token).toBe('rotated-refresh');
    expect(await journal.readAll()).toEqual([]);
  });
  it('replays idempotently when recovery preserves a newer existing id token', async () => {
    const first = account();
    first.token.id_token = 'existing-id';
    await CloudAccountRepo.init();
    await CloudAccountRepo.addAccount(first);
    const record = {
      version: 1 as const,
      accountId: first.id,
      expected: { access_token: first.token.access_token, refresh_token: first.token.refresh_token },
      token: { ...first.token, access_token: 'rotated-access', refresh_token: 'rotated-refresh', id_token: undefined },
    };
    expect(await applyOAuthRecoveryRecord(record)).toBe('applied');
    expect((await CloudAccountRepo.getAccount(first.id))?.token.id_token).toBe('existing-id');
    expect(await applyOAuthRecoveryRecord(record)).toBe('applied');
  });
  it('replays an encrypted journal into SQLite before removing the record', async () => {
    const first = account();
    await CloudAccountRepo.init();
    await CloudAccountRepo.addAccount(first);
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
    const journal = new OAuthRecoveryJournal(path.join(state.directory, 'recovery'));
    await journal.append({
      version: 1,
      accountId: first.id,
      expected: { access_token: first.token.access_token, refresh_token: first.token.refresh_token },
      token: { ...first.token, access_token: 'rotated-access', refresh_token: 'rotated-refresh' },
    });
    await recoverOAuthJournal(new OAuthRecoveryJournal(path.join(state.directory, 'recovery')));
    expect((await CloudAccountRepo.getAccount(first.id))?.token.refresh_token).toBe('rotated-refresh');
    expect(await journal.readAll()).toEqual([]);
  });

  it('recovers a pending journal on repository initialization', async () => {
    const first = account();
    await CloudAccountRepo.init();
    await CloudAccountRepo.addAccount(first);
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
    const journal = new OAuthRecoveryJournal(path.join(state.directory, 'oauth-recovery'));
    await journal.append({
      version: 1,
      accountId: first.id,
      expected: { access_token: first.token.access_token, refresh_token: first.token.refresh_token },
      token: { ...first.token, access_token: 'rotated-access', refresh_token: 'rotated-refresh' },
    });
    await CloudAccountRepo.init();
    expect((await CloudAccountRepo.getAccount(first.id))?.token.refresh_token).toBe('rotated-refresh');
    expect(await journal.readAll()).toEqual([]);
  });

  it('fails initialization without altering account data when a recovery record is corrupt', async () => {
    const first = account();
    await CloudAccountRepo.init();
    await CloudAccountRepo.addAccount(first);
    const directory = path.join(state.directory, 'oauth-recovery');
    fs.mkdirSync(directory);
    const file = path.join(directory, '00000000-0000-4000-8000-000000000000.recovery');
    fs.writeFileSync(file, 'corrupt');

    await expect(CloudAccountRepo.init()).rejects.toThrow('Invalid OAuth recovery journal entry');
    expect((await CloudAccountRepo.getAccount(first.id))?.token).toEqual(first.token);
    expect(fs.readFileSync(file, 'utf8')).toBe('corrupt');
  });

  it('does not resurrect a deleted account during startup recovery', async () => {
    const first = account();
    await CloudAccountRepo.init();
    await CloudAccountRepo.addAccount(first);
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
    const journal = new OAuthRecoveryJournal(path.join(state.directory, 'oauth-recovery'));
    const name = await journal.append({
      version: 1,
      accountId: first.id,
      expected: { access_token: first.token.access_token, refresh_token: first.token.refresh_token },
      token: { ...first.token, access_token: 'rotated-access', refresh_token: 'rotated-refresh' },
    });
    await CloudAccountRepo.removeAccount(first.id);
    await expect(CloudAccountRepo.init()).rejects.toThrow('manual resolution: missing');
    expect(await CloudAccountRepo.getAccount(first.id)).toBeUndefined();
    expect((await journal.readAll()).map((entry) => entry.name)).toEqual([name]);
  });

  it.each(['cleanup-failure', 'reauthorization'] as const)(
    'preserves the journal safely after %s',
    async (scenario) => {
      const first = account();
      await CloudAccountRepo.init();
      await CloudAccountRepo.addAccount(first);
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
      const journal = new OAuthRecoveryJournal(path.join(state.directory, 'recovery'));
      const name = await journal.append({
        version: 1,
        accountId: first.id,
        expected: { access_token: first.token.access_token, refresh_token: first.token.refresh_token },
        token: { ...first.token, access_token: 'rotated-access', refresh_token: 'rotated-refresh' },
      });
      if (scenario === 'cleanup-failure') {
        vi.spyOn(journal, 'remove').mockRejectedValueOnce(new Error('cleanup failed'));
        await expect(recoverOAuthJournal(journal)).rejects.toThrow('cleanup failed');
        expect((await CloudAccountRepo.getAccount(first.id))?.token.refresh_token).toBe('rotated-refresh');
        expect(await journal.readAll()).toHaveLength(1);
        await recoverOAuthJournal(journal);
        expect(await journal.readAll()).toEqual([]);
      } else {
        const replacement = { ...first.token, access_token: 'replacement-access', refresh_token: 'replacement-refresh' };
        await CloudAccountRepo.updateToken(first.id, replacement);
        await expect(recoverOAuthJournal(journal)).rejects.toThrow('manual resolution');
        expect((await CloudAccountRepo.getAccount(first.id))?.token).toEqual(replacement);
        expect((await journal.readAll()).map((entry) => entry.name)).toEqual([name]);
      }
    },
  );

  it('preserves reauthorization racing with OAuth recovery', async () => {
    const first = account();
    await CloudAccountRepo.init();
    await CloudAccountRepo.addAccount(first);
    const replacement = { ...first.token, access_token: 'replacement-access', refresh_token: 'replacement-refresh' };
    const record = {
      version: 1 as const,
      accountId: first.id,
      expected: { access_token: first.token.access_token, refresh_token: first.token.refresh_token },
      token: { ...first.token, access_token: 'rotated-access', refresh_token: 'rotated-refresh' },
    };
    const compare = CloudAccountRepo.compareAndUpdateToken.bind(CloudAccountRepo);
    vi.spyOn(CloudAccountRepo, 'compareAndUpdateToken').mockImplementationOnce(async (...args) => {
      await CloudAccountRepo.updateToken(first.id, replacement);
      return compare(...args);
    });

    expect(await applyOAuthRecoveryRecord(record)).toBe('conflict');
    expect((await CloudAccountRepo.getAccount(first.id))?.token).toEqual(replacement);
  });

  it('replays OAuth recovery atomically without overwriting a replacement account', async () => {
    const first = account();
    await CloudAccountRepo.init();
    await CloudAccountRepo.addAccount(first);
    const record = {
      version: 1 as const,
      accountId: first.id,
      expected: { access_token: first.token.access_token, refresh_token: first.token.refresh_token },
      token: { ...first.token, access_token: 'rotated-access', refresh_token: 'rotated-refresh' },
    };
    expect(await applyOAuthRecoveryRecord(record)).toBe('applied');
    expect((await CloudAccountRepo.getAccount(first.id))?.token.refresh_token).toBe('rotated-refresh');
    expect(await applyOAuthRecoveryRecord(record)).toBe('applied');
    const replacement = { ...first.token, access_token: 'replacement-access', refresh_token: 'replacement-refresh' };
    await CloudAccountRepo.updateToken(first.id, replacement);
    expect(await applyOAuthRecoveryRecord(record)).toBe('conflict');
    expect((await CloudAccountRepo.getAccount(first.id))?.token).toEqual(replacement);
    expect(await applyOAuthRecoveryRecord({ ...record, accountId: 'missing' })).toBe('missing');
  });
  it('recovers a rotated token on process restart when process crashed before SQLite persist', async () => {
    const first = account();
    first.token.expiry_timestamp = 1;
    first.token.project_id = 'project';
    await CloudAccountRepo.init();
    await CloudAccountRepo.addAccount(first);

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

    const store = {
      ...cloudAccountStoreAdapter,
      compareAndUpdateToken: vi.fn(async () => {
        throw new Error('SQLite disk I/O error');
      }),
    };
    const upstream: AccountLeaseUpstream = {
      fetchQuota: vi.fn(),
      refreshAccessToken: vi.fn(async () => ({
        access_token: 'rotated-access',
        refresh_token: 'rotated-refresh',
        expires_in: 3600,
        token_type: 'Bearer',
      })),
      fetchProjectId: vi.fn(),
      normalizeRefreshedOAuthClientKey: vi.fn((token) => token.oauth_client_key),
    };

    const service = new AccountLeaseService(store, upstream);
    await service.loadAccounts();
    const leased = await service.getNextToken({ targetAccountId: first.id });
    expect(leased?.token.refresh_token).toBe('rotated-refresh');

    // Simulate process crash: onModuleDestroy is NOT called! Process memory is abandoned.
    // SQLite on disk still has the old credentials:
    expect((await CloudAccountRepo.getAccount(first.id))?.token.refresh_token).toBe('refresh-one');

    // Restart: new process initializes and loads accounts
    const restarted = new AccountLeaseService(cloudAccountStoreAdapter, upstream);
    await restarted.loadAccounts();

    // Rotated token was restored into SQLite and cache from the durable journal:
    expect((await CloudAccountRepo.getAccount(first.id))?.token.refresh_token).toBe('rotated-refresh');
    expect((await restarted.getNextToken({ targetAccountId: first.id }))?.token.refresh_token).toBe('rotated-refresh');
    expect(upstream.refreshAccessToken).toHaveBeenCalledTimes(1);
    await restarted.onModuleDestroy();
  });
  it('does not overwrite reauthorized credentials when recovering from a crash on restart', async () => {
    const first = account();
    first.token.expiry_timestamp = 1;
    first.token.project_id = 'project';
    await CloudAccountRepo.init();
    await CloudAccountRepo.addAccount(first);

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

    const store = {
      ...cloudAccountStoreAdapter,
      compareAndUpdateToken: vi.fn(async () => {
        throw new Error('SQLite write failed');
      }),
    };
    const upstream: AccountLeaseUpstream = {
      fetchQuota: vi.fn(),
      refreshAccessToken: vi.fn(async () => ({
        access_token: 'rotated-access',
        refresh_token: 'rotated-refresh',
        expires_in: 3600,
        token_type: 'Bearer',
      })),
      fetchProjectId: vi.fn(),
      normalizeRefreshedOAuthClientKey: vi.fn((token) => token.oauth_client_key),
    };

    const service = new AccountLeaseService(store, upstream);
    await service.loadAccounts();
    await service.getNextToken({ targetAccountId: first.id });

    // While process is dead, user reauthorizes through UI / re-login:
    const reauthorized = {
      ...first.token,
      access_token: 'reauth-access',
      refresh_token: 'reauth-refresh',
      expiry_timestamp: Math.floor(Date.now() / 1000) + 3600,
    };
    await CloudAccountRepo.updateToken(first.id, reauthorized);

    // On restart, journal detects conflict and does NOT overwrite the reauthorized token:
    const restarted = new AccountLeaseService(cloudAccountStoreAdapter, upstream);
    await expect(restarted.loadAccounts()).rejects.toThrow('manual resolution: conflict');
    expect((await CloudAccountRepo.getAccount(first.id))?.token).toEqual(reauthorized);
  });
  it('does not resurrect a deleted account when recovering from a crash on restart', async () => {
    const first = account();
    first.token.expiry_timestamp = 1;
    first.token.project_id = 'project';
    await CloudAccountRepo.init();
    await CloudAccountRepo.addAccount(first);

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

    const store = {
      ...cloudAccountStoreAdapter,
      compareAndUpdateToken: vi.fn(async () => {
        throw new Error('SQLite write failed');
      }),
    };
    const upstream: AccountLeaseUpstream = {
      fetchQuota: vi.fn(),
      refreshAccessToken: vi.fn(async () => ({
        access_token: 'rotated-access',
        refresh_token: 'rotated-refresh',
        expires_in: 3600,
        token_type: 'Bearer',
      })),
      fetchProjectId: vi.fn(),
      normalizeRefreshedOAuthClientKey: vi.fn((token) => token.oauth_client_key),
    };

    const service = new AccountLeaseService(store, upstream);
    await service.loadAccounts();
    await service.getNextToken({ targetAccountId: first.id });
    // Let the background failure settle (in a real crash the process would terminate):
    await new Promise((resolve) => setTimeout(resolve, 20));

    // While process is dead, user deletes the account:
    await CloudAccountRepo.removeAccount(first.id);

    // On restart, journal detects account is missing and does NOT resurrect it:
    const restarted = new AccountLeaseService(cloudAccountStoreAdapter, upstream);
    await expect(restarted.loadAccounts()).rejects.toThrow('manual resolution: missing');
    expect(await CloudAccountRepo.getAccount(first.id)).toBeUndefined();
  });
  it('persists a failed rotated token before clean shutdown when storage recovers', async () => {
    const first = account();
    first.token.expiry_timestamp = 1;
    first.token.project_id = 'project';
    await CloudAccountRepo.init();
    await CloudAccountRepo.addAccount(first);
    let attempts = 0;
    const store = { ...cloudAccountStoreAdapter, compareAndUpdateToken: async (...args: Parameters<typeof cloudAccountStoreAdapter.compareAndUpdateToken>) => {
      if (++attempts === 1) { throw new Error('temporary failure'); }
      return cloudAccountStoreAdapter.compareAndUpdateToken(...args);
    } };
    const upstream: AccountLeaseUpstream = {
      fetchQuota: vi.fn(),
      refreshAccessToken: vi.fn(async () => ({ access_token: 'rotated-access', refresh_token: 'rotated-refresh', expires_in: 3600, token_type: 'Bearer' })),
      fetchProjectId: vi.fn(),
      normalizeRefreshedOAuthClientKey: vi.fn((token) => token.oauth_client_key),
    };
    const service = new AccountLeaseService(store, upstream);
    await service.loadAccounts();
    await service.getNextToken({ targetAccountId: first.id });
    await service.onModuleDestroy();
    expect((await CloudAccountRepo.getAccount(first.id))?.token.refresh_token).toBe('rotated-refresh');
    const restarted = new AccountLeaseService(cloudAccountStoreAdapter, upstream);
    await restarted.loadAccounts();
    expect((await restarted.getNextToken({ targetAccountId: first.id }))?.token.refresh_token).toBe('rotated-refresh');
    expect(upstream.refreshAccessToken).toHaveBeenCalledTimes(1);
    await restarted.onModuleDestroy();
  });
  it.each([false, true])('handles reauthorization %s after refresh and project writes both fail', async (reauthorize) => {
    const first = account();
    first.token.expiry_timestamp = 1;
    first.token.project_id = undefined;
    await CloudAccountRepo.init();
    await CloudAccountRepo.addAccount(first);
    let fail = true;
    let firstWriteFailed = false;
    const store = { ...cloudAccountStoreAdapter, getAccount: async (id: string) => {
      if (fail && firstWriteFailed) { throw new Error('storage unavailable'); }
      return cloudAccountStoreAdapter.getAccount(id);
    }, compareAndUpdateToken: async (...args: Parameters<typeof cloudAccountStoreAdapter.compareAndUpdateToken>) => {
      if (fail) { firstWriteFailed = true; throw new Error('storage unavailable'); }
      return cloudAccountStoreAdapter.compareAndUpdateToken(...args);
    } };
    const upstream: AccountLeaseUpstream = {
      fetchQuota: vi.fn(),
      refreshAccessToken: vi.fn(async () => ({ access_token: 'rotated-access', refresh_token: 'rotated-refresh', expires_in: 3600, token_type: 'Bearer' })),
      fetchProjectId: vi.fn(async () => 'discovered-project'),
      normalizeRefreshedOAuthClientKey: vi.fn((token) => token.oauth_client_key),
    };
    const service = new AccountLeaseService(store, upstream);
    await service.loadAccounts();
    await service.getNextToken({ targetAccountId: first.id });
    await expect(service.onModuleDestroy()).rejects.toThrow('storage unavailable');
    const replacement = { ...first.token, access_token: 'reauthorized-access', refresh_token: 'reauthorized-refresh', expiry_timestamp: Math.floor(Date.now() / 1000) + 3600, project_id: 'replacement-project' };
    if (reauthorize) {
      await CloudAccountRepo.updateToken(first.id, replacement);
    }
    fail = false;
    await service.reloadAllAccountsOrThrow();
    const expected = reauthorize ? 'reauthorized-refresh' : 'rotated-refresh';
    expect((await CloudAccountRepo.getAccount(first.id))?.token.refresh_token).toBe(expected);
    expect((await service.getNextToken({ targetAccountId: first.id }))?.token.refresh_token).toBe(expected);
    expect(upstream.refreshAccessToken).toHaveBeenCalledTimes(1);
  });
  it('does not reload stale OAuth credentials after persistent write conflicts', async () => {
    const first = account();
    first.token.expiry_timestamp = 1;
    first.token.project_id = 'project';
    await CloudAccountRepo.init();
    await CloudAccountRepo.addAccount(first);
    const store = { ...cloudAccountStoreAdapter, compareAndUpdateToken: vi.fn(async () => false) };
    const upstream: AccountLeaseUpstream = {
      fetchQuota: vi.fn(),
      refreshAccessToken: vi.fn(async () => ({ access_token: 'rotated-access', refresh_token: 'rotated-refresh', expires_in: 3600, token_type: 'Bearer' })),
      fetchProjectId: vi.fn(),
      normalizeRefreshedOAuthClientKey: vi.fn((token) => token.oauth_client_key),
    };
    const service = new AccountLeaseService(store, upstream);
    await service.loadAccounts();
    await service.getNextToken({ targetAccountId: first.id });
    await expect(service.onModuleDestroy()).rejects.toThrow('account changed during update');
    await expect(service.reloadAllAccountsOrThrow()).rejects.toThrow();
    expect((await service.getNextToken({ targetAccountId: first.id }))?.token.refresh_token).toBe('rotated-refresh');
    expect(upstream.refreshAccessToken).toHaveBeenCalledTimes(1);
  });
  it('retains a rotated refresh token across cache reload after a persistence failure', async () => {
    const first = account();
    first.token.expiry_timestamp = 1;
    first.token.project_id = 'project';
    await CloudAccountRepo.init();
    await CloudAccountRepo.addAccount(first);
    let fail = true;
    const store = { ...cloudAccountStoreAdapter, compareAndUpdateToken: async (...args: Parameters<typeof cloudAccountStoreAdapter.compareAndUpdateToken>) => {
      if (fail) { throw new Error('storage unavailable'); }
      return cloudAccountStoreAdapter.compareAndUpdateToken(...args);
    } };
    const upstream: AccountLeaseUpstream = {
      fetchQuota: vi.fn(),
      refreshAccessToken: vi.fn(async () => ({ access_token: 'rotated-access', refresh_token: 'rotated-refresh', expires_in: 3600, token_type: 'Bearer' })),
      fetchProjectId: vi.fn(),
      normalizeRefreshedOAuthClientKey: vi.fn((token) => token.oauth_client_key),
    };
    const service = new AccountLeaseService(store, upstream);
    await service.loadAccounts();
    expect((await service.getNextToken({ targetAccountId: first.id }))?.token.refresh_token).toBe('rotated-refresh');
    await expect(service.onModuleDestroy()).rejects.toThrow('storage unavailable');
    fail = false;
    await service.reloadAllAccounts();
    expect((await service.getNextToken({ targetAccountId: first.id }))?.token.refresh_token).toBe('rotated-refresh');
    expect(upstream.refreshAccessToken).toHaveBeenCalledTimes(1);
  });
  it('preserves a concurrent project change while saving a rotated lease token', async () => {
    const first = account();
    first.token.expiry_timestamp = 1;
    first.token.project_id = 'old-project';
    await CloudAccountRepo.init();
    await CloudAccountRepo.addAccount(first);
    let entered!: () => void;
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const resume = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const store = {
      ...cloudAccountStoreAdapter,
      compareAndUpdateToken: async (
        ...args: Parameters<typeof cloudAccountStoreAdapter.compareAndUpdateToken>
      ) => {
        if (++calls === 1) {
          entered();
          await resume;
        }
        return cloudAccountStoreAdapter.compareAndUpdateToken(...args);
      },
    };
    const upstream: AccountLeaseUpstream = {
      fetchQuota: vi.fn(),
      refreshAccessToken: vi.fn(async () => ({
        access_token: 'rotated-access',
        refresh_token: 'rotated-refresh',
        expires_in: 3600,
        token_type: 'Bearer',
      })),
      fetchProjectId: vi.fn(),
      normalizeRefreshedOAuthClientKey: vi.fn((token) => token.oauth_client_key),
    };
    const service = new AccountLeaseService(store, upstream);
    await service.loadAccounts();
    expect((await service.getNextToken({ targetAccountId: first.id }))?.token.refresh_token).toBe(
      'rotated-refresh',
    );
    await waiting;
    await CloudAccountRepo.updateToken(first.id, { ...first.token, project_id: 'new-project' });
    release();
    await service.onModuleDestroy();
    const saved = await CloudAccountRepo.getAccount(first.id);
    expect(saved?.token.refresh_token).toBe('rotated-refresh');
    expect(saved?.token.project_id).toBe('new-project');
  });

  it.each([false, true])(
    'persists lease token rotation without overwriting replacement: %s',
    async (replace) => {
      const first = account();
      first.token.expiry_timestamp = 1;
      first.token.project_id = 'project';
      await CloudAccountRepo.init();
      await CloudAccountRepo.addAccount(first);
      let release!: () => void;
      let entered!: () => void;
      const waiting = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const resume = new Promise<void>((resolve) => {
        release = resolve;
      });
      const upstream: AccountLeaseUpstream = {
        fetchQuota: vi.fn(),
        refreshAccessToken: vi.fn(async () => ({
          access_token: 'rotated-access',
          refresh_token: 'rotated-refresh',
          expires_in: 3600,
          token_type: 'Bearer',
        })),
        fetchProjectId: vi.fn(),
        normalizeRefreshedOAuthClientKey: vi.fn((token) => token.oauth_client_key),
      };
      const store = {
        ...cloudAccountStoreAdapter,
        compareAndUpdateToken: async (
          ...args: Parameters<typeof cloudAccountStoreAdapter.compareAndUpdateToken>
        ) => {
          entered();
          await resume;
          return cloudAccountStoreAdapter.compareAndUpdateToken(...args);
        },
      };
      const service = new AccountLeaseService(store, upstream);
      await service.loadAccounts();
      const lease = await service.getNextToken({ targetAccountId: first.id });
      expect(lease?.token.refresh_token).toBe('rotated-refresh');
      await waiting;
      const replacement = {
        ...first.token,
        access_token: 'replacement-access',
        refresh_token: 'replacement-refresh',
      };
      if (replace) {
        await CloudAccountRepo.updateToken(first.id, replacement);
      }
      release();
      await service.onModuleDestroy();
      const saved = await CloudAccountRepo.getAccount(first.id);
      expect(saved?.token.refresh_token).toBe(replace ? 'replacement-refresh' : 'rotated-refresh');
      expect(saved?.token.access_token).toBe(replace ? 'replacement-access' : 'rotated-access');
    },
  );

  it('atomically accepts a rotated token and rejects a stale snapshot', async () => {
    const first = account();
    await CloudAccountRepo.init();
    await CloudAccountRepo.addAccount(first);
    const rotated = {
      ...first.token,
      access_token: 'rotated-access',
      refresh_token: 'rotated-refresh',
    };
    expect(await CloudAccountRepo.compareAndUpdateToken(first.id, first.token, rotated)).toBe(true);
    const replacement = {
      ...rotated,
      access_token: 'reauthorized-access',
      refresh_token: 'reauthorized-refresh',
    };
    await CloudAccountRepo.updateToken(first.id, replacement);
    expect(await CloudAccountRepo.compareAndUpdateToken(first.id, rotated, first.token)).toBe(
      false,
    );
    expect((await CloudAccountRepo.getAccount(first.id))?.token).toEqual(replacement);
    expect(await CloudAccountRepo.compareAndUpdateToken('missing', first.token, rotated)).toBe(
      false,
    );
  });

  it('reopens add, token update and batch import without a master key', async () => {
    vi.spyOn(security, 'initializeMasterKey').mockRejectedValue(
      new Error('Plaintext accounts must not load a master key'),
    );
    const first = account();
    await CloudAccountRepo.init();
    await CloudAccountRepo.addAccount(first);
    await CloudAccountRepo.updateToken(first.id, { ...first.token, access_token: 'access-two' });
    const second = { ...account(), id: 'account-two', email: 'other@example.com' };
    await upsertCloudAccountsAtomically([second]);

    const database = new Database(path.join(state.directory, 'cloud_accounts.db'), {
      readonly: true,
    });
    try {
      const rows = database
        .prepare('SELECT id, token_json, quota_json, health_json FROM accounts ORDER BY id')
        .all() as Array<{
        id: string;
        token_json: string;
        quota_json: string;
        health_json: string;
      }>;
      expect(rows).toEqual([
        {
          id: 'account-one',
          token_json: JSON.stringify({ ...first.token, access_token: 'access-two' }),
          quota_json: JSON.stringify(first.quota),
          health_json: JSON.stringify(first.health),
        },
        {
          id: 'account-two',
          token_json: JSON.stringify(second.token),
          quota_json: JSON.stringify(second.quota),
          health_json: JSON.stringify(second.health),
        },
      ]);
    } finally {
      database.close();
    }

    expect((await CloudAccountRepo.getAccounts()).map((stored) => stored.id)).toEqual([
      'account-one',
      'account-two',
    ]);
    expect((await CloudAccountRepo.getAccount(first.id))?.token.access_token).toBe('access-two');
  });

  it('backs up old ciphertext and converts it before normal account reads', async () => {
    const first = account();
    await CloudAccountRepo.init();
    await CloudAccountRepo.addAccount(first);
    const dbPath = path.join(state.directory, 'cloud_accounts.db');
    const key = Buffer.alloc(32, 7);
    const encryptedToken = encryptWithKey(key, JSON.stringify(first.token)).slice(
      ENCRYPTED_PAYLOAD_VERSION_PREFIX.length,
    );
    const encryptedQuota = encryptWithKey(key, JSON.stringify(first.quota));
    const encryptedHealth = encryptWithKey(key, JSON.stringify(first.health));
    const database = new Database(dbPath);
    try {
      database
        .prepare('UPDATE accounts SET token_json = ?, quota_json = ?, health_json = ? WHERE id = ?')
        .run(encryptedToken, encryptedQuota, encryptedHealth, first.id);
    } finally {
      database.close();
    }

    vi.spyOn(security, 'initializeMasterKey').mockResolvedValue({
      state: 'secure',
      masterKeySource: 'keytar',
    });
    vi.spyOn(security, 'decryptWithMigration').mockImplementation(async (value) => {
      const payload = parseEncryptedPayload(value);
      if (!payload) {
        throw new Error('Invalid test payload');
      }
      return { value: decryptParsedPayloadWithKey(key, payload) };
    });

    await CloudAccountRepo.init();

    const backupName = fs
      .readdirSync(state.directory)
      .find((name) => name.startsWith('cloud_accounts.db.account-migration-'));
    if (!backupName) {
      throw new Error('Encrypted account backup was not created');
    }
    const backup = new Database(path.join(state.directory, backupName, 'encrypted.db'), {
      readonly: true,
    });
    const current = new Database(dbPath, { readonly: true });
    try {
      expect(
        backup
          .prepare('SELECT token_json, quota_json, health_json FROM accounts WHERE id = ?')
          .get(first.id),
      ).toEqual({
        token_json: encryptedToken,
        quota_json: encryptedQuota,
        health_json: encryptedHealth,
      });
      expect(
        current
          .prepare('SELECT token_json, quota_json, health_json FROM accounts WHERE id = ?')
          .get(first.id),
      ).toEqual({
        token_json: JSON.stringify(first.token),
        quota_json: JSON.stringify(first.quota),
        health_json: JSON.stringify(first.health),
      });
    } finally {
      backup.close();
      current.close();
    }
    vi.restoreAllMocks();
    await CloudAccountRepo.init();
    expect(
      fs
        .readdirSync(state.directory)
        .filter(
          (name) =>
            name.startsWith('cloud_accounts.db.account-migration-') &&
            !name.endsWith('-shm') &&
            !name.endsWith('-wal'),
        ),
    ).toEqual([backupName]);
    expect((await CloudAccountRepo.getAccount(first.id))?.token).toEqual(first.token);
  });
});

describe('cloud-account active references', () => {
  function snapshot() {
    const database = new Database(path.join(state.directory, 'cloud_accounts.db'), {
      readonly: true,
    });
    try {
      return {
        accounts: database.prepare('SELECT id FROM accounts ORDER BY id').all(),
        settings: database.prepare('SELECT key, value FROM settings ORDER BY key').all(),
      };
    } finally {
      database.close();
    }
  }

  function preventReferenceCleanup() {
    const database = new Database(path.join(state.directory, 'cloud_accounts.db'));
    try {
      database.exec(`
        CREATE TRIGGER reject_active_cleanup BEFORE DELETE ON settings
        WHEN OLD.key = 'active_cloud_account.agy'
        BEGIN SELECT RAISE(ABORT, 'fixture cleanup failure'); END;
      `);
    } finally {
      database.close();
    }
  }

  it('deletes all references to the removed account while preserving other accounts and settings', async () => {
    await CloudAccountRepo.init();
    await CloudAccountRepo.addAccount(account());
    await CloudAccountRepo.addAccount({ ...account(), id: 'account-two' });
    CloudAccountSettingsStore.setActiveForTarget('classic', account().id);
    CloudAccountSettingsStore.setActiveForTarget('ide', 'account-two');
    CloudAccountSettingsStore.setActiveForTarget('agy', `  ${account().id}  `);
    CloudAccountSettingsStore.setSetting('unrelated-setting', account().id);

    await CloudAccountRepo.removeAccount(account().id);

    expect(snapshot()).toEqual({
      accounts: [{ id: 'account-two' }],
      settings: [
        { key: 'active_cloud_account.ide', value: JSON.stringify('account-two') },
        { key: 'unrelated-setting', value: JSON.stringify(account().id) },
      ],
    });
    expect(
      (['classic', 'ide', 'agy'] as const).map((target) =>
        CloudAccountSettingsStore.getActiveAccountIdForTarget(target),
      ),
    ).toEqual(['', 'account-two', '']);
  });

  it('cleans a reference to an already removed account and allows repeated deletion', async () => {
    await CloudAccountRepo.init();
    CloudAccountSettingsStore.setActiveForTarget('agy', 'already-removed');

    await CloudAccountRepo.removeAccount('already-removed');
    await CloudAccountRepo.removeAccount('already-removed');

    expect(snapshot()).toEqual({ accounts: [], settings: [] });
  });

  it('cleans historical missing references at startup without choosing or switching an account', async () => {
    await CloudAccountRepo.init();
    await CloudAccountRepo.addAccount(account());
    CloudAccountSettingsStore.setActiveForTarget('classic', 'old-classic');
    CloudAccountSettingsStore.setActiveForTarget('ide', account().id);
    CloudAccountSettingsStore.setActiveForTarget('agy', 'old-agy');
    CloudAccountSettingsStore.setSetting('active_cloud_account.custom', 'old-custom');

    await CloudAccountRepo.init();
    const firstStartup = snapshot();
    await CloudAccountRepo.init();

    expect(snapshot()).toEqual(firstStartup);
    expect(firstStartup).toEqual({
      accounts: [{ id: account().id }],
      settings: [
        { key: 'active_cloud_account.custom', value: JSON.stringify('old-custom') },
        { key: 'active_cloud_account.ide', value: JSON.stringify(account().id) },
      ],
    });
    expect((await CloudAccountRepo.getAccount(account().id))?.is_active).toBe(false);
  });

  it('rolls back account deletion if any active-reference cleanup fails', async () => {
    await CloudAccountRepo.init();
    await CloudAccountRepo.addAccount(account());
    CloudAccountSettingsStore.setActiveForTarget('classic', account().id);
    CloudAccountSettingsStore.setActiveForTarget('agy', account().id);
    preventReferenceCleanup();
    const before = snapshot();

    await expect(CloudAccountRepo.removeAccount(account().id)).rejects.toThrow(
      'fixture cleanup failure',
    );

    expect(snapshot()).toEqual(before);
  });

  it('rolls back all startup cleanup if a later reference cannot be removed', async () => {
    await CloudAccountRepo.init();
    CloudAccountSettingsStore.setActiveForTarget('classic', 'old-classic');
    CloudAccountSettingsStore.setActiveForTarget('agy', 'old-agy');
    preventReferenceCleanup();
    const before = snapshot();

    await expect(CloudAccountRepo.init()).rejects.toThrow('fixture cleanup failure');

    expect(snapshot()).toEqual(before);
  });
});
