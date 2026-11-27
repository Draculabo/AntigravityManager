import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalAccountImportService } from '@/modules/cloud-account/local-import/local-account-import.service';
import { localAccountPostImportService } from '@/modules/cloud-account/local-import/local-account-post-import.service';
import { CloudAccountRepo } from '@/modules/cloud-account/persistence/cloudHandler';
import { upsertCloudAccountsAtomically } from '@/modules/cloud-account/persistence/cloud-account-batch-writer';
import { CloudAccountRefreshService } from '@/modules/cloud-account/services/CloudAccountRefreshService';
import { importCloudAccountRefreshToken } from '@/modules/cloud-account/services/cloud-account-credential-import.service';
import { importCloudAccounts } from '@/modules/cloud-account/services/cloud-account-file-policy.service';
import { GoogleAPIService } from '@/modules/cloud-account/services/GoogleAPIService';
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
vi.mock('@/modules/identity-profile/public', () => ({
  prepareDesktopIdentityStorage: vi.fn(async () => undefined),
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
  vi.restoreAllMocks();
  fs.rmSync(state.directory, { recursive: true, force: true });
});

describe('SQLite import commit ownership', () => {
  it.each(['same', 'replacement'] as const)(
    'retains stored Google proof only for a backup import with the same grant (%s)',
    async (grant) => {
      const original = account();
      const before = await CloudAccountRepo.insertAccount(original, 'synthetic-verified-subject');
      vi.spyOn(CloudAccountRefreshService, 'clearFailureState').mockResolvedValue(undefined);
      vi.spyOn(localAccountPostImportService, 'schedule').mockReturnValue(undefined);
      const refreshToken = grant === 'same' ? original.token.refresh_token : 'replacement';
      const result = await importCloudAccounts(
        JSON.stringify({
          version: '1.0',
          exportedAt: 1,
          accounts: [
            {
              provider: original.provider,
              email: original.email,
              name: 'Imported owner',
              token: { ...original.token, refresh_token: refreshToken },
            },
          ],
        }),
      );
      expect(result).toMatchObject({ updated: 1, imported: 0, failed: 0 });
      const stored = await CloudAccountRepo.getAccount(original.id);
      expect(stored?.name).toBe('Imported owner');
      expect(stored?.token.refresh_token).toBe(refreshToken);
      expect(stored?.google_usage_subject_hash).toBe(
        grant === 'same' ? before.google_usage_subject_hash : undefined,
      );
    },
  );

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

  it('keeps a verified subject through local token metadata import and pasted reauthorization', async () => {
    const original = account();
    const subject = 'synthetic-verified-subject';
    const before = await CloudAccountRepo.insertAccount(original, subject);
    expect(before.google_usage_subject_hash).toMatch(/^[a-f0-9]{64}$/);

    const result = await new LocalAccountImportService().importSession({
      result: {
        accounts: [
          {
            fingerprint: 'test-import',
            sources: [],
            emailHints: [original.email],
            hasAccessToken: true,
            hasIdToken: false,
          },
        ],
      },
      getCredential: () => ({
        refreshToken: original.token.refresh_token,
        accessToken: 'discovered-access',
        expiryTimestamp: 9999999999,
      }),
    });
    expect(result).toEqual({
      imported: [
        {
          fingerprint: 'test-import',
          accountId: original.id,
          email: original.email,
          action: 'updated',
        },
      ],
      skipped: [],
      failed: [],
    });
    expect(await CloudAccountRepo.getAccount(original.id)).toMatchObject({
      google_usage_subject_hash: before.google_usage_subject_hash,
      token: { access_token: 'discovered-access', refresh_token: original.token.refresh_token },
    });

    vi.spyOn(GoogleAPIService, 'refreshAccessToken').mockResolvedValue({
      access_token: 'pasted-access',
      expires_in: 3600,
      token_type: 'Bearer',
    });
    vi.spyOn(GoogleAPIService, 'getUserInfo').mockResolvedValue({
      email: original.email,
      id: subject,
      name: 'Verified account',
      verified_email: true,
    });
    vi.spyOn(CloudAccountRefreshService, 'clearFailureState').mockResolvedValue(undefined);
    await expect(
      importCloudAccountRefreshToken({ refreshToken: 'replacement-grant' }),
    ).resolves.toEqual({ status: 'updated', email: original.email });
    expect(await CloudAccountRepo.getAccount(original.id)).toMatchObject({
      google_usage_subject_hash: before.google_usage_subject_hash,
      token: { refresh_token: 'replacement-grant' },
    });
  });

  it.each([{ refresh_token: 'other-grant' }, { oauth_client_key: 'other-client' }])(
    'clears proof when the imported token changes its grant binding by %j',
    async (change) => {
      const original = account();
      const before = await CloudAccountRepo.insertAccount(original, 'synthetic-verified-subject');
      const next = { ...before, token: { ...before.token, ...change } };

      await upsertCloudAccountsAtomically([next], [before]);

      expect(await CloudAccountRepo.getAccount(original.id)).toMatchObject({ token: next.token });
      expect(
        (await CloudAccountRepo.getAccount(original.id))?.google_usage_subject_hash,
      ).toBeUndefined();
    },
  );

  it('does not persist subject evidence on a newly imported local account', async () => {
    const original = account();
    await upsertCloudAccountsAtomically(
      [{ ...original, google_usage_subject_hash: 'a'.repeat(64) }],
      [],
    );
    const saved = await CloudAccountRepo.getAccount(original.id);
    expect(saved).toMatchObject({ token: original.token });
    expect(saved?.google_usage_subject_hash).toBeUndefined();
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
