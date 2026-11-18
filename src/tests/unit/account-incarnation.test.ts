import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CloudAccountRepo } from '@/modules/cloud-account/persistence/cloudHandler';
import { captureTokenWriteGuard } from '@/modules/cloud-account/services/cloud-account-refresh-writeback';
import { AccountLeaseService } from '@/server/gateway/modules/account-lease/account-lease.service';
import {
  cloudAccountStoreAdapter,
  type AccountLeaseUpstream,
} from '@/server/gateway/modules/account-lease/interfaces/account-lease-adapters';
import type { CloudAccount } from '@/modules/cloud-account/types';
import { exportCloudAccounts } from '@/modules/cloud-account/services/cloud-account-file-policy.service';
import { ModelAvailabilityService } from '@/server/gateway/shared/services/model-availability.service';
import { ProxyRetryService } from '@/server/gateway/shared/services/proxy-retry.service';

const state = vi.hoisted(() => ({ directory: '' }));
vi.mock('better-sqlite3', async () => {
  const { createRequire } = await import('node:module');
  return { default: createRequire(import.meta.url)('better-sqlite3') };
});
vi.mock('@/shared/platform/paths', () => ({
  getCloudAccountsDbPath: () => path.join(state.directory, 'accounts.db'),
}));

function account(): CloudAccount {
  return {
    id: 'same-id',
    provider: 'google',
    email: 'synthetic@example.com',
    created_at: 1,
    last_used: 1,
    token: {
      access_token: 'synthetic-access',
      refresh_token: 'synthetic-grant',
      token_type: 'Bearer',
      expires_in: 3600,
      expiry_timestamp: 4102444800,
    },
  };
}
beforeEach(() => {
  state.directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agm-incarnation-'));
});
afterEach(() => {
  fs.rmSync(state.directory, { recursive: true, force: true });
});

describe('account incarnation ownership', () => {
  it('returns the inserted incarnation and refuses to overwrite an existing ID', async () => {
    const original = account();
    const inserted = await CloudAccountRepo.insertAccount(original);
    expect(inserted).toEqual(await CloudAccountRepo.getAccount(original.id));
    expect(inserted.lifecycle_generation).toMatch(/^[a-f0-9]{32}$/);
    await expect(
      CloudAccountRepo.insertAccount({ ...original, name: 'must-not-overwrite' }),
    ).rejects.toThrow();
    expect(await CloudAccountRepo.getAccount(original.id)).toEqual(inserted);
  });

  it('preserves replacement capability protection before the lease cache reloads', async () => {
    const original = account();
    original.token.project_id = 'synthetic-project';
    await CloudAccountRepo.addAccount(original);
    const availability = new ModelAvailabilityService();
    const lease = new AccountLeaseService(
      cloudAccountStoreAdapter,
      {
        fetchQuota: vi.fn(),
        fetchProjectId: vi.fn(),
        refreshAccessToken: vi.fn(),
        normalizeRefreshedOAuthClientKey: vi.fn(),
      },
      undefined,
      availability,
    );
    try {
      const token = await lease.getNextToken({ model: 'gemini-3-flash' });
      if (!token) {
        throw new Error('Missing issued fixture');
      }
      await CloudAccountRepo.removeAccount(original.id);
      await CloudAccountRepo.addAccount(original);
      availability.mark(original.id, 'gemini-3-flash', 'model_not_supported');
      const snapshot = availability.getSnapshot();
      const retry = new ProxyRetryService(lease, { log: vi.fn(), warn: vi.fn() }, availability);
      retry.markUpstreamSuccess(original.id, 'gemini-3-flash', () => lease.isLeaseCurrent(token));
      expect(availability.getSnapshot()).toEqual(snapshot);
    } finally {
      await lease.onModuleDestroy();
    }
  });

  it('does not bind a stale successful lease before cache reload after same-value recreation', async () => {
    const original = account();
    original.token.project_id = 'synthetic-project';
    await CloudAccountRepo.addAccount(original);
    await CloudAccountRepo.addAccount({ ...original, id: 'other-account' });
    const lease = new AccountLeaseService(cloudAccountStoreAdapter, {
      fetchQuota: vi.fn(),
      fetchProjectId: vi.fn(),
      refreshAccessToken: vi.fn(),
      normalizeRefreshedOAuthClientKey: vi.fn(),
    });
    try {
      const issued = await lease.getNextToken({
        sessionKey: 'synthetic-session',
        model: 'gemini-3-flash',
      });
      if (!issued) {
        throw new Error('Missing issued fixture');
      }
      const issuedAccount = await CloudAccountRepo.getAccount(issued.id);
      if (!issuedAccount) {
        throw new Error('Missing stored issued fixture');
      }
      await CloudAccountRepo.removeAccount(issued.id);
      await CloudAccountRepo.addAccount(issuedAccount);
      lease.commitSession(issued);
      const alternateId = issued.id === original.id ? 'other-account' : original.id;
      expect(
        (await lease.getNextToken({ sessionKey: 'synthetic-session', model: 'gemini-3-flash' }))
          ?.id,
      ).toBe(alternateId);
    } finally {
      await lease.onModuleDestroy();
    }
  });

  it('keeps an upsert incarnation stable, ignores a copied incarnation on insert and omits it from exports', async () => {
    const original = account();
    await CloudAccountRepo.addAccount(original);
    const first = await CloudAccountRepo.getAccount(original.id);
    if (!first) {
      throw new Error('Missing fixture');
    }
    await CloudAccountRepo.addAccount({ ...first, name: 'updated-name' });
    expect((await CloudAccountRepo.getAccount(original.id))?.lifecycle_generation).toBe(
      first.lifecycle_generation,
    );
    expect(await exportCloudAccounts()).not.toContain('lifecycle_generation');
    await CloudAccountRepo.removeAccount(original.id);
    await CloudAccountRepo.addAccount(first);
    expect((await CloudAccountRepo.getAccount(original.id))?.lifecycle_generation).not.toBe(
      first.lifecycle_generation,
    );
  });
  it('rejects an issued lease before cache reload after durable identical-value replacement', async () => {
    const original = account();
    original.token.project_id = 'synthetic-project';
    await CloudAccountRepo.addAccount(original);
    const upstream: AccountLeaseUpstream = {
      fetchQuota: vi.fn(),
      fetchProjectId: vi.fn(),
      refreshAccessToken: vi.fn(),
      normalizeRefreshedOAuthClientKey: vi.fn(),
    };
    const lease = new AccountLeaseService(cloudAccountStoreAdapter, upstream);
    try {
      const issued = await lease.getNextToken();
      if (!issued) {
        throw new Error('Missing issued fixture');
      }
      expect(lease.isLeaseCurrent(issued)).toBe(true);
      await CloudAccountRepo.removeAccount(original.id);
      await CloudAccountRepo.addAccount(original);
      expect(lease.isLeaseCurrent(issued)).toBe(false);
      await lease.loadAccounts();
      const replacement = await lease.getNextToken();
      if (!replacement) {
        throw new Error('Missing replacement fixture');
      }
      expect(lease.isLeaseCurrent(replacement)).toBe(true);
    } finally {
      await lease.onModuleDestroy();
    }
  });
  it('rejects a previously read token guard after identical-value deletion and recreation', async () => {
    const original = account();
    await CloudAccountRepo.addAccount(original);
    const observed = await CloudAccountRepo.getAccount(original.id);
    if (!observed) {
      throw new Error('Missing fixture');
    }
    const guard = captureTokenWriteGuard(observed);
    await CloudAccountRepo.removeAccount(original.id);
    await CloudAccountRepo.addAccount(original);
    await expect(
      CloudAccountRepo.updateToken(
        original.id,
        { ...original.token, access_token: 'stale-result' },
        guard,
      ),
    ).rejects.toMatchObject({ name: 'CloudAccountRefreshContextChangedError' });
    expect((await CloudAccountRepo.getAccount(original.id))?.token).toEqual(original.token);
  });

  it('rejects an identical old import plan without restoring its active status', async () => {
    const original = account();
    await CloudAccountRepo.addAccount(original);
    const expected = await CloudAccountRepo.getAccounts();
    await CloudAccountRepo.removeAccount(original.id);
    await CloudAccountRepo.addAccount(original);
    await expect(
      CloudAccountRepo.addAccount({ ...original, is_active: true }, expected),
    ).rejects.toMatchObject({ name: 'CloudAccountImportConflictError' });
    expect((await CloudAccountRepo.getAccount(original.id))?.is_active).toBe(false);
  });
});
