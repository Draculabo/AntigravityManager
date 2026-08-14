import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { dbPath } = vi.hoisted(() => ({
  dbPath: `${process.cwd()}/.tmp-cloud-account-delete-${process.pid}.db`,
}));

vi.mock('@/shared/platform/paths', () => ({
  getCloudAccountsDbPath: () => dbPath,
}));

vi.mock('@/shared/logging/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { getCloudDb } from '@/modules/cloud-account/persistence/cloud-account-db';

function removeDatabaseFiles(): void {
  for (const suffix of ['', '-wal', '-shm']) {
    const filePath = `${dbPath}${suffix}`;
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  }
}

describe('cloud account deletion state cleanup', () => {
  beforeEach(() => {
    removeDatabaseFiles();
  });

  afterEach(() => {
    removeDatabaseFiles();
  });

  it('removes only target-active settings that reference the deleted account', () => {
    const { raw } = getCloudDb();
    const deletedAccountId = 'account-deleted';
    const retainedAccountId = 'account-retained';

    try {
      const insertAccount = raw.prepare(`
        INSERT INTO accounts (
          id, provider, email, token_json, created_at, last_used
        ) VALUES (?, 'google', ?, '{}', 1, 1)
      `);
      insertAccount.run(deletedAccountId, 'deleted@example.com');
      insertAccount.run(retainedAccountId, 'retained@example.com');

      const insertSetting = raw.prepare('INSERT INTO settings (key, value) VALUES (?, ?)');
      insertSetting.run('active_cloud_account.classic', JSON.stringify(deletedAccountId));
      insertSetting.run('active_cloud_account.ide', JSON.stringify(retainedAccountId));
      insertSetting.run('active_cloud_account.agy', JSON.stringify(deletedAccountId));
      insertSetting.run('language', JSON.stringify(deletedAccountId));

      raw.prepare('DELETE FROM accounts WHERE id = ?').run(deletedAccountId);

      const rows = raw
        .prepare('SELECT key, value FROM settings ORDER BY key')
        .all() as Array<{ key: string; value: string }>;

      expect(rows).toEqual([
        {
          key: 'active_cloud_account.ide',
          value: JSON.stringify(retainedAccountId),
        },
        {
          key: 'language',
          value: JSON.stringify(deletedAccountId),
        },
      ]);
    } finally {
      raw.close();
    }
  });
});
