import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CloudAccountRepo } from '@/modules/cloud-account/persistence/cloudHandler';
import { CloudAccountSettingsStore } from '@/modules/cloud-account/persistence/cloud-account-settings-store';
import { upsertCloudAccountsAtomically } from '@/modules/cloud-account/persistence/cloud-account-batch-writer';
import type { CloudAccount } from '@/modules/cloud-account/types';
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
      .find((name) => name.startsWith('cloud_accounts.db.encrypted-backup-'));
    if (!backupName) {
      throw new Error('Encrypted account backup was not created');
    }
    const backup = new Database(path.join(state.directory, backupName), { readonly: true });
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
            name.startsWith('cloud_accounts.db.encrypted-backup-') &&
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
