import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CloudAccountRepo } from '@/modules/cloud-account/persistence/cloudHandler';
import { getCloudDb } from '@/modules/cloud-account/persistence/cloud-account-db';
import { upsertCloudAccountsAtomically } from '@/modules/cloud-account/persistence/cloud-account-batch-writer';
import { GoogleAPIService } from '@/modules/cloud-account/services/GoogleAPIService';
import { CloudAccountRefreshService } from '@/modules/cloud-account/services/CloudAccountRefreshService';
import { enrollGoogleAccount } from '@/modules/cloud-account/services/google-account-enrollment.service';
import { GoogleLoginOperation } from '@/modules/cloud-account/services/google-login-operation';
import { prepareDesktopIdentityStorage } from '@/modules/identity-profile/public';
import { createAccount } from './proxy-real-path.harness';

const state = vi.hoisted(() => ({ directory: '', emails: new Map<string, string>() }));
vi.mock('better-sqlite3', async () => {
  const { createRequire } = await import('node:module');
  return { default: createRequire(import.meta.url)('better-sqlite3') };
});
vi.mock('@/shared/platform/paths', () => ({
  getCloudAccountsDbPath: () => path.join(state.directory, 'accounts.db'),
}));
vi.mock('@/modules/identity-profile/public', () => ({
  prepareDesktopIdentityStorage: vi.fn(async () => ({})),
}));
vi.mock('@/server/main', () => ({ reloadNestServerAccountLeaseCache: vi.fn(async () => true) }));

function observe<T>(promise: Promise<T>) {
  return promise.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
}
function start(code: string, email: string, operation = new GoogleLoginOperation()) {
  state.emails.set(`synthetic-${code}`, email);
  return observe(
    enrollGoogleAccount(code, { redirectUri: 'http://127.0.0.1/callback', operation }),
  );
}
function pausePreparation() {
  const entered = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  vi.mocked(prepareDesktopIdentityStorage).mockImplementationOnce(async () => {
    entered.resolve();
    await resume.promise;
    return {};
  });
  return { entered: entered.promise, resume };
}

beforeEach(() => {
  state.directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agm-enrollment-duplicate-'));
  state.emails.clear();
  vi.spyOn(GoogleAPIService, 'exchangeCode').mockImplementation(async (code) => ({
    access_token: `synthetic-${code}`,
    refresh_token: `synthetic-grant-${code}`,
    token_type: 'Bearer',
    expires_in: 3600,
  }));
  vi.spyOn(GoogleAPIService, 'getUserInfo').mockImplementation(async (accessToken) => ({
    id: accessToken,
    email: state.emails.get(accessToken) ?? 'synthetic@example.invalid',
    name: accessToken,
    picture: '',
    verified_email: true,
  }));
  vi.spyOn(GoogleAPIService, 'fetchQuota').mockResolvedValue({ models: {} });
  vi.spyOn(GoogleAPIService, 'fetchAICredits').mockResolvedValue(null);
  vi.spyOn(CloudAccountRefreshService, 'clearFailureState').mockResolvedValue();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(prepareDesktopIdentityStorage).mockReset();
  vi.mocked(prepareDesktopIdentityStorage).mockResolvedValue({});
  CloudAccountRefreshService.resetStateForTesting();
  fs.rmSync(state.directory, { recursive: true, force: true });
});

describe('atomic Google email admission with native SQLite', () => {
  for (const emails of [
    ['same@example.invalid', 'same@example.invalid'],
    ['Mixed@Example.invalid', 'mixed@example.invalid'],
    ['User@Ä.example', 'user@ä.example'],
  ]) {
    it.each([0, 1])(
      `keeps only the first commit for ${emails.join(' / ')} with winner %s`,
      async (winner) => {
        const unrelated = await CloudAccountRepo.insertAccount({
          ...createAccount('unrelated'),
          is_active: true,
        });
        const gates = [pausePreparation(), pausePreparation()];
        const operations = [new GoogleLoginOperation(), new GoogleLoginOperation()];
        const pending = emails.map((email, index) =>
          start(`attempt-${index}`, email, operations[index]),
        );
        try {
          await Promise.all(gates.map((gate) => gate.entered));
          gates[winner].resume.resolve();
          expect(await pending[winner]).toHaveProperty('value.email', emails[winner]);
          const expected = await CloudAccountRepo.getAccounts();
          gates[1 - winner].resume.resolve();
          const result = await pending[1 - winner];
          expect(result).toMatchObject({
            error: {
              name: 'DuplicateGoogleAccountError',
              stage: 'account-persist',
              accountCommit: 'not-attempted',
              fallbackReason: 'duplicate-account',
            },
          });
          expect(operations[1 - winner].accountCommit).toBe('not-attempted');
          expect(await CloudAccountRepo.getAccounts()).toEqual(expected);
          expect(await CloudAccountRepo.getAccount(unrelated.id)).toEqual(unrelated);
          expect(GoogleAPIService.fetchQuota).toHaveBeenCalledExactlyOnceWith(
            `synthetic-attempt-${winner}`,
          );
          expect(CloudAccountRefreshService.clearFailureState).toHaveBeenCalledOnce();
        } finally {
          for (const gate of gates) {
            gate.resume.resolve();
          }
          await Promise.all(pending);
        }
      },
    );
  }

  it('rejects a pending enrollment if an import claims its email before insertion', async () => {
    const gate = pausePreparation();
    const pending = start('pending', 'shared@example.invalid');
    try {
      await gate.entered;
      await upsertCloudAccountsAtomically(
        [{ ...createAccount('imported'), email: 'SHARED@example.invalid' }],
        [],
      );
      const expected = await CloudAccountRepo.getAccounts();
      gate.resume.resolve();
      expect(await pending).toMatchObject({
        error: { name: 'DuplicateGoogleAccountError', accountCommit: 'not-attempted' },
      });
      expect(await CloudAccountRepo.getAccounts()).toEqual(expected);
      expect(GoogleAPIService.fetchQuota).not.toHaveBeenCalled();
      expect(CloudAccountRefreshService.clearFailureState).not.toHaveBeenCalled();
    } finally {
      gate.resume.resolve();
      await pending;
    }
  });

  it('preserves an enrolled account when an older import plan later claims its email', async () => {
    expect(await start('winner', 'shared@example.invalid')).toHaveProperty('value');
    const expected = await CloudAccountRepo.getAccounts();
    await expect(
      upsertCloudAccountsAtomically(
        [{ ...createAccount('imported'), email: 'SHARED@example.invalid' }],
        [],
      ),
    ).rejects.toMatchObject({ name: 'CloudAccountImportConflictError' });
    expect(await CloudAccountRepo.getAccounts()).toEqual(expected);
  });

  it('does not hold unrelated emails behind a waiting enrollment', async () => {
    const gate = pausePreparation();
    const pending = start('waiting', 'waiting@example.invalid');
    try {
      await gate.entered;
      expect(await start('independent', 'independent@example.invalid')).toHaveProperty(
        'value.email',
        'independent@example.invalid',
      );
      gate.resume.resolve();
      expect(await pending).toHaveProperty('value.email', 'waiting@example.invalid');
      expect(await CloudAccountRepo.getAccounts()).toHaveLength(2);
    } finally {
      gate.resume.resolve();
      await pending;
    }
  });

  it('does not merge dotted addresses or plus aliases during admission', async () => {
    for (const email of [
      'first.last@gmail.com',
      'firstlast@gmail.com',
      'firstlast+tag@gmail.com',
    ]) {
      expect(await start(email, email)).toHaveProperty('value.email', email);
    }
    expect(await CloudAccountRepo.getAccounts()).toHaveLength(3);
  });

  it('keeps an existing malformed-token row instead of treating unreadable credentials as absence', async () => {
    const existing = await CloudAccountRepo.insertAccount({
      ...createAccount('malformed'),
      email: 'same@example.invalid',
    });
    const { raw } = getCloudDb();
    try {
      raw.prepare('UPDATE accounts SET token_json = ? WHERE id = ?').run('{}', existing.id);
    } finally {
      raw.close();
    }
    expect(await start('new', 'SAME@example.invalid')).toMatchObject({
      error: {
        name: 'DuplicateGoogleAccountError',
        stage: 'account-persist',
        accountCommit: 'not-attempted',
      },
    });
    const readback = getCloudDb();
    try {
      expect(readback.raw.prepare('SELECT id, token_json FROM accounts').all()).toEqual([
        { id: existing.id, token_json: '{}' },
      ]);
    } finally {
      readback.raw.close();
    }
    expect(GoogleAPIService.fetchQuota).not.toHaveBeenCalled();
  });

  it('does not classify an unrelated insertion failure as a duplicate or retry it', async () => {
    const { raw } = getCloudDb();
    try {
      raw.exec(
        "CREATE TRIGGER deny_insert AFTER INSERT ON accounts BEGIN SELECT RAISE(ABORT, 'synthetic write failure'); END",
      );
    } finally {
      raw.close();
    }
    const operation = new GoogleLoginOperation();
    expect(await start('failed', 'same@example.invalid', operation)).toMatchObject({
      error: {
        name: 'GoogleLoginStepError',
        stage: 'account-persist',
        accountCommit: 'uncertain',
        fallbackReason: 'storage-failed',
        cause: { message: 'synthetic write failure' },
      },
    });
    expect(await CloudAccountRepo.getAccounts()).toEqual([]);
    expect(GoogleAPIService.fetchQuota).not.toHaveBeenCalled();
    expect(GoogleAPIService.exchangeCode).toHaveBeenCalledOnce();
    const connection = getCloudDb();
    try {
      connection.raw.exec('DROP TRIGGER deny_insert');
    } finally {
      connection.raw.close();
    }
    expect(await start('retry-explicit', 'same@example.invalid')).toHaveProperty('value');
  });

  it('admits a fresh enrollment after the original winner was deleted', async () => {
    const gate = pausePreparation();
    const pending = start('pending', 'same@example.invalid');
    try {
      await gate.entered;
      const stored = await CloudAccountRepo.insertAccount({
        ...createAccount('temporary'),
        email: 'same@example.invalid',
      });
      await CloudAccountRepo.removeAccount(stored.id);
      gate.resume.resolve();
      expect(await pending).toHaveProperty('value.email', 'same@example.invalid');
      expect(await CloudAccountRepo.getAccounts()).toHaveLength(1);
    } finally {
      gate.resume.resolve();
      await pending;
    }
  });
  it('keeps committed enrollment even if finalization fails before another attempt', async () => {
    vi.mocked(CloudAccountRefreshService.clearFailureState).mockRejectedValueOnce(
      new Error('synthetic finalization failure'),
    );
    expect(await start('winner', 'same@example.invalid')).toMatchObject({
      error: {
        name: 'GoogleLoginStepError',
        stage: 'account-finalize',
        accountCommit: 'confirmed',
      },
    });
    const expected = await CloudAccountRepo.getAccounts();
    expect(expected).toHaveLength(1);
    expect(await start('loser', 'SAME@example.invalid')).toMatchObject({
      error: {
        name: 'DuplicateGoogleAccountError',
        stage: 'duplicate-check',
        accountCommit: 'not-attempted',
      },
    });
    expect(await CloudAccountRepo.getAccounts()).toEqual(expected);
    expect(CloudAccountRefreshService.clearFailureState).toHaveBeenCalledOnce();
    expect(GoogleAPIService.fetchQuota).not.toHaveBeenCalled();
  });
});
