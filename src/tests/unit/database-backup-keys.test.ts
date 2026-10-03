import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { backupAccount } from '@/modules/account/persistence/antigravity-state-database';
import { ProtobufUtils } from '@/shared/serialization/protobuf';

const values = vi.hoisted(() => new Map<string, string>());
const paths = vi.hoisted(() => vi.fn(() => ['/selected/state.vscdb']));
vi.mock('@/shared/platform/paths', () => ({ getAntigravityDbPaths: paths }));
vi.mock('@/modules/antigravity-runtime', () => ({
  resolveClientAccountStorage: async () => 'sqlite',
}));
vi.mock('drizzle-orm', async (original) => ({
  ...(await original<typeof import('drizzle-orm')>()),
  eq: (_column: unknown, key: string) => ({ key }),
}));
vi.mock('@/shared/persistence/database/dbConnection', () => {
  const db = {
    select: () => ({
      from: () => ({
        where: (condition: { key: string }) => ({
          all: () => (values.has(condition.key) ? [{ value: values.get(condition.key) }] : []),
        }),
      }),
    }),
  };
  return {
    openDrizzleConnection: () => ({
      raw: { close: vi.fn() },
      orm: {
        ...db,
        transaction: (read: (connection: typeof db) => unknown) => read(db),
      },
    }),
  };
});
beforeEach(() => {
  vi.clearAllMocks();
  values.clear();
  vi.spyOn(fs, 'existsSync').mockReturnValue(true);
});
describe('account snapshot capture', () => {
  it('captures OAuth, user and enterprise project state from the selected data directory', async () => {
    const oauth = ProtobufUtils.createUnifiedOAuthToken(
      'access',
      'refresh',
      1900000000,
      false,
      'id',
    );
    const user = ProtobufUtils.createUnifiedStateEntry(
      'userStatusSentinelKey',
      ProtobufUtils.createMinimalUserStatusPayload('fixture@example.invalid'),
    );
    const project = ProtobufUtils.createUnifiedStateEntry(
      'enterpriseGcpProjectId',
      ProtobufUtils.createStringValuePayload('fixture-project'),
    );
    values.set('antigravityUnifiedStateSync.oauthToken', oauth);
    values.set('antigravityUnifiedStateSync.userStatus', user);
    values.set('antigravityUnifiedStateSync.enterprisePreferences', project);
    values.set('workspace.unrelated', 'excluded');
    const account = {
      id: 'fixture',
      email: 'fixture@example.invalid',
      name: 'Fixture',
      created_at: '2026-01-01',
      last_used: '2026-01-01',
    };
    const result = await backupAccount(account, 'ide', { userDataDir: '/selected' });
    expect(paths).toHaveBeenCalledWith('ide', { userDataDir: '/selected' });
    expect(result).toEqual({
      version: '1.0',
      account,
      data: {
        account_email: account.email,
        backup_time: expect.any(String),
        'antigravityUnifiedStateSync.oauthToken': oauth,
        'antigravityUnifiedStateSync.userStatus': user,
        'antigravityUnifiedStateSync.enterprisePreferences': project,
      },
    });
  });
});
