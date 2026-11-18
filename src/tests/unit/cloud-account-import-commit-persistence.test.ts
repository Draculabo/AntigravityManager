import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CloudAccountRepo } from '@/modules/cloud-account/persistence/cloudHandler';
import { upsertCloudAccountsAtomically } from '@/modules/cloud-account/persistence/cloud-account-batch-writer';
import type { CloudAccount } from '@/modules/cloud-account/types';
import { cloudAccountStoreAdapter } from '@/server/gateway/modules/account-lease/interfaces/account-lease-adapters';
import {
  captureLeaseWriteGuard,
  leaseStoredContext,
} from '@/server/gateway/modules/account-lease/policies/account-lease-writeback';
import type { AccountLeaseTokenData } from '@/server/gateway/modules/account-lease/interfaces/account-lease-token-types';

const state = vi.hoisted(() => ({ directory: '' }));
vi.mock('better-sqlite3', async () => {
  const { createRequire } = await import('node:module');
  return { default: createRequire(import.meta.url)('better-sqlite3') };
});
vi.mock('@/shared/platform/paths', () => ({
  getCloudAccountsDbPath: () => path.join(state.directory, 'cloud_accounts.db'),
}));

function account(id = 'one'): CloudAccount {
  return {
    id,
    provider: 'google',
    email: `${id}@example.com`,
    created_at: 1,
    last_used: 2,
    token: {
      access_token: 'access',
      refresh_token: `grant-${id}`,
      token_type: 'Bearer',
      expires_in: 3600,
      expiry_timestamp: 5000,
    },
  };
}

beforeEach(() => {
  state.directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agm-import-commit-'));
});
afterEach(() => {
  fs.rmSync(state.directory, { recursive: true, force: true });
});

describe('SQLite import commit ownership', () => {
  it.each(['token', 'quota', 'health'] as const)(
    'forwards a lease %s guard through the production adapter into SQLite',
    async (field) => {
      const original = account();
      await CloudAccountRepo.addAccount(original);
      const token: AccountLeaseTokenData = {
        ...original.token,
        email: original.email,
        account_id: original.id,
        model_quotas: {},
        model_limits: {},
        model_reset_times: {},
        model_forwarding_rules: {},
        stored_context: leaseStoredContext(original),
      };
      const guard = captureLeaseWriteGuard(token, () => true);
      await CloudAccountRepo.updateToken(original.id, {
        ...original.token,
        access_token: 'replacement',
      });
      const before = await CloudAccountRepo.getAccount(original.id);
      const write =
        field === 'token'
          ? cloudAccountStoreAdapter.updateToken(original.id, original.token, guard)
          : field === 'quota'
            ? cloudAccountStoreAdapter.updateQuota(original.id, { models: {} }, guard)
            : cloudAccountStoreAdapter.mutateHealth(
                original.id,
                () => ({ oauth: { refresh_blocked: true } }),
                guard,
              );
      await expect(write).rejects.toMatchObject({ name: 'CloudAccountRefreshContextChangedError' });
      expect(await CloudAccountRepo.getAccount(original.id)).toEqual(before);
    },
  );
  it.each(['deleted', 'token', 'quota', 'health', 'active'] as const)(
    'rejects a stale whole-row import after %s changed',
    async (change) => {
      const original = account();
      await CloudAccountRepo.addAccount(original);
      const expected = await CloudAccountRepo.getAccounts();
      if (change === 'deleted') {
        await CloudAccountRepo.removeAccount(original.id);
      }
      if (change === 'token') {
        await CloudAccountRepo.updateToken(original.id, {
          ...original.token,
          access_token: 'replacement',
        });
      }
      if (change === 'quota') {
        await CloudAccountRepo.updateQuota(original.id, { models: {} });
      }
      if (change === 'health') {
        await CloudAccountRepo.updateHealth(original.id, { oauth: { refresh_blocked: true } });
      }
      if (change === 'active') {
        CloudAccountRepo.setActive(original.id);
      }
      const before = await CloudAccountRepo.getAccounts();
      await expect(
        CloudAccountRepo.addAccount(
          { ...original, name: 'Stale import', is_active: true },
          expected,
        ),
      ).rejects.toMatchObject({ name: 'CloudAccountImportConflictError' });
      expect(await CloudAccountRepo.getAccounts()).toEqual(before);
    },
  );

  it.each(['id', 'email', 'grant'] as const)(
    'rejects a new import when another writer claims its %s',
    async (collision) => {
      const next = account();
      const concurrent = account('other');
      if (collision === 'id') {
        concurrent.id = next.id;
      }
      if (collision === 'email') {
        concurrent.email = next.email.toUpperCase();
      }
      if (collision === 'grant') {
        concurrent.token.refresh_token = next.token.refresh_token;
      }
      await CloudAccountRepo.addAccount(concurrent);
      const before = await CloudAccountRepo.getAccounts();
      await expect(CloudAccountRepo.addAccount(next, [])).rejects.toMatchObject({
        name: 'CloudAccountImportConflictError',
      });
      expect(await CloudAccountRepo.getAccounts()).toEqual(before);
    },
  );

  it('checks all local-import rows before writing any of them', async () => {
    const first = account('first');
    const second = account('second');
    await upsertCloudAccountsAtomically([first, second]);
    const expected = await CloudAccountRepo.getAccounts();
    await CloudAccountRepo.removeAccount(second.id);
    const before = await CloudAccountRepo.getAccounts();
    await expect(
      upsertCloudAccountsAtomically(
        [
          { ...first, name: 'First' },
          { ...second, name: 'Second' },
        ],
        expected,
      ),
    ).rejects.toMatchObject({ name: 'CloudAccountImportConflictError' });
    expect(await CloudAccountRepo.getAccounts()).toEqual(before);
  });

  it('allows unrelated account additions and unchanged optional JSON fields', async () => {
    const original = account();
    original.token.project_id = undefined;
    await CloudAccountRepo.addAccount(original);
    const expected = await CloudAccountRepo.getAccounts();
    const unrelated = account('unrelated');
    await CloudAccountRepo.addAccount(unrelated);
    await CloudAccountRepo.addAccount({ ...original, name: 'Imported' }, expected);
    expect((await CloudAccountRepo.getAccount(original.id))?.name).toBe('Imported');
    expect((await CloudAccountRepo.getAccount(unrelated.id))?.token).toEqual(unrelated.token);
  });

  it('does not deactivate a new active account chosen while an IDE import was preparing', async () => {
    const next = account();
    const active = account('active');
    await upsertCloudAccountsAtomically([next, active]);
    const expected = await CloudAccountRepo.getAccounts();
    CloudAccountRepo.setActive(active.id);
    const before = await CloudAccountRepo.getAccounts();
    await expect(
      CloudAccountRepo.addAccount({ ...next, is_active: true }, expected),
    ).rejects.toMatchObject({ name: 'CloudAccountImportConflictError' });
    expect(await CloudAccountRepo.getAccounts()).toEqual(before);
  });
});
