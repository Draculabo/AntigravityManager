import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { expect, it, vi } from 'vitest';
import { CloudAccountRepo } from '@/modules/cloud-account/persistence/cloudHandler';
import { setCloudAccountRouting } from '@/modules/cloud-account/services/cloud-account-routing.service';
import { projectCloudAccountView } from '@/modules/cloud-account/services/cloud-account-view';
import { createAccount } from './proxy-real-path.harness';

const { paths, updateRouting } = vi.hoisted(() => ({
  paths: { database: '' },
  updateRouting: vi.fn(),
}));
vi.mock('@/server/main', () => ({ updateNestServerAccountRouting: updateRouting }));
vi.mock('@/shared/platform/paths', async (original) => ({
  ...(await original<typeof import('@/shared/platform/paths')>()),
  getCloudAccountsDbPath: () => paths.database,
}));
vi.mock('better-sqlite3', async () => {
  const { createRequire } = await import('node:module');
  return { default: createRequire(import.meta.url)('better-sqlite3') };
});

it('migrates existing accounts and saves or clears optional family priorities', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'agm-routing-'));
  paths.database = join(directory, 'accounts.db');
  try {
    const raw = new Database(paths.database);
    try {
      raw.exec(`CREATE TABLE accounts (
        id TEXT PRIMARY KEY, provider TEXT NOT NULL, email TEXT NOT NULL, name TEXT,
        avatar_url TEXT, token_json TEXT NOT NULL, quota_json TEXT, created_at INTEGER NOT NULL,
        last_used INTEGER NOT NULL, status TEXT, proxy_priority INTEGER NOT NULL DEFAULT 50
      )`);
      raw
        .prepare(
          `INSERT INTO accounts
        (id, provider, email, token_json, created_at, last_used, status, proxy_priority)
        VALUES (?, 'google', ?, ?, 1, 1, 'active', 27)`,
        )
        .run('account', 'account@example.test', JSON.stringify(createAccount('account').token));
    } finally {
      raw.close();
    }

    const old = await CloudAccountRepo.getAccount('account');
    expect(old?.proxy_priority).toBe(27);
    expect(old?.proxy_priority_overrides).toBeUndefined();
    const base = { accountId: 'account', proxyPriority: 30, proxyEnabled: true };
    await setCloudAccountRouting({
      ...base,
      proxyPriorityOverrides: { gemini: 5, claude: 80 },
    });
    const saved = await CloudAccountRepo.getAccount('account');
    if (!saved) {
      throw new Error('Migrated account is missing');
    }
    expect(updateRouting).toHaveBeenCalledExactlyOnceWith(saved);
    expect(projectCloudAccountView(saved).proxy_priority_overrides).toEqual({
      gemini: 5,
      claude: 80,
    });
    expect(CloudAccountRepo.setAccountRouting(base).proxy_priority_overrides).toEqual({
      gemini: 5,
      claude: 80,
    });
    CloudAccountRepo.setAccountRouting({ ...base, proxyPriorityOverrides: {} });
    const cleared = await CloudAccountRepo.getAccount('account');
    expect(cleared?.proxy_priority_overrides).toBeUndefined();
    expect(cleared?.token).toEqual(old?.token);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
