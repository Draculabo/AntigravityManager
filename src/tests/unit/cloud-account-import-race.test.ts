import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isEqual } from 'lodash-es';
import type { CloudAccount } from '@/modules/cloud-account/types';
import { CloudAccountRepo } from '@/modules/cloud-account/persistence/cloudHandler';
import { importCloudAccounts } from '@/modules/cloud-account/services/cloud-account-file-policy.service';
import { localAccountPostImportService } from '@/modules/cloud-account/local-import/local-account-post-import.service';
import {
  LocalAccountImportService,
  type LocalAccountImportSession,
} from '@/modules/cloud-account/local-import/local-account-import.service';

vi.mock('@/modules/identity-profile/public', () => ({ prepareDesktopIdentityStorage: vi.fn() }));
vi.mock('@/modules/cloud-account/persistence/cloudHandler', () => ({
  CloudAccountRepo: { getAccounts: vi.fn(), addAccount: vi.fn() },
}));
vi.mock('@/modules/cloud-account/services/CloudAccountRefreshService', () => ({
  CloudAccountRefreshService: { clearFailureState: vi.fn() },
}));
vi.mock('@/modules/cloud-account/local-import/local-account-post-import.service', () => ({
  localAccountPostImportService: { schedule: vi.fn() },
}));

function account(): CloudAccount {
  return {
    id: 'one',
    provider: 'google',
    email: 'one@example.com',
    created_at: 1,
    last_used: 2,
    status: 'active',
    is_active: false,
    token: {
      access_token: 'access',
      refresh_token: 'grant',
      token_type: 'Bearer',
      expires_in: 3600,
      expiry_timestamp: 5000,
    },
  };
}

beforeEach(() => vi.resetAllMocks());

describe('import commit ownership', () => {
  it.each(['deleted', 'token', 'quota', 'active'] as const)(
    'does not overwrite an account changed by %s while file import waits to commit',
    async (change) => {
      const initial = account();
      let stored: CloudAccount[] = [structuredClone(initial)];
      const entered = Promise.withResolvers<void>();
      const resume = Promise.withResolvers<void>();
      vi.mocked(CloudAccountRepo.getAccounts).mockImplementation(async () =>
        structuredClone(stored),
      );
      vi.mocked(CloudAccountRepo.addAccount).mockImplementation(async (next, expected) => {
        entered.resolve();
        await resume.promise;
        if (expected && !isEqual(stored, expected)) {
          throw new Error('stale import');
        }
        stored = [next];
      });
      const pending = importCloudAccounts(
        JSON.stringify({
          version: '1.0',
          exportedAt: 1,
          accounts: [{ ...initial, name: 'Imported' }],
        }),
      );
      await entered.promise;
      if (change === 'deleted') {
        stored = [];
      }
      if (change === 'token') {
        stored[0].token.access_token = 'new-access';
      }
      if (change === 'quota') {
        stored[0].quota = { models: { model: { percentage: 42, resetTime: 'later' } } };
      }
      if (change === 'active') {
        stored[0].is_active = true;
      }
      const before = structuredClone(stored);
      resume.resolve();
      expect(await pending).toMatchObject({
        imported: 0,
        updated: 0,
        failed: 1,
        errors: [{ code: 'account-write-failed' }],
      });
      expect(stored).toEqual(before);
      expect(localAccountPostImportService.schedule).toHaveBeenCalledWith([]);
    },
  );

  it('passes the planning snapshot through the local import commit boundary', async () => {
    const initial = account();
    const entered = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    let stored = [structuredClone(initial)];
    const service = new LocalAccountImportService({
      getAccounts: async () => structuredClone(stored),
      upsertAccounts: async (next, expected) => {
        entered.resolve();
        await resume.promise;
        if (expected && !isEqual(stored, expected)) {
          throw new Error('stale import');
        }
        stored = next;
      },
      createId: () => 'new',
      now: () => 100,
    });
    const session: LocalAccountImportSession = {
      result: {
        accounts: [
          {
            fingerprint: 'fp',
            sources: [],
            emailHints: [initial.email],
            hasAccessToken: true,
            hasIdToken: false,
          },
        ],
      },
      getCredential: () => ({
        refreshToken: 'grant',
        accessToken: 'discovered',
        expiryTimestamp: 1000,
      }),
    };
    const pending = service.importSession(session);
    await entered.promise;
    stored[0].token.access_token = 'replacement';
    const before = structuredClone(stored);
    resume.resolve();
    expect(await pending).toMatchObject({ imported: [], failed: [{ code: 'persistence-failed' }] });
    expect(stored).toEqual(before);
  });
});
