import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import {
  backupAccount,
  getCurrentAccountInfo,
} from '@/modules/account/persistence/antigravity-state-database';
import { ProtobufUtils } from '@/shared/serialization/protobuf';

const values = vi.hoisted(() => new Map<string, string>());
const paths = vi.hoisted(() => vi.fn(() => ['/selected/state.vscdb']));
const runtime = vi.hoisted(() => ({
  storage: 'sqlite' as 'cli-session' | 'sqlite',
  readClientAccountToken: vi.fn(),
}));
vi.mock('@/shared/platform/paths', () => ({ getAntigravityDbPaths: paths }));
vi.mock('@/modules/antigravity-runtime', () => ({
  resolveClientAccountStorage: async () => runtime.storage,
  readClientAccountToken: runtime.readClientAccountToken,
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
  runtime.storage = 'sqlite';
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

  it('captures an Agy CLI session without opening the host state database', async () => {
    runtime.storage = 'cli-session';
    runtime.readClientAccountToken.mockResolvedValue({
      accessToken: 'cli-access',
      refreshToken: 'cli-refresh',
      expiryTimestamp: 1900000000,
      idToken: 'cli-id',
      projectId: 'cli-project',
    });
    const account = {
      id: 'cli-fixture',
      email: 'cli@example.invalid',
      name: 'CLI Fixture',
      created_at: '2026-01-01',
      last_used: '2026-01-01',
    };

    const result = await backupAccount(account, 'agy');

    expect(runtime.readClientAccountToken).toHaveBeenCalledWith('agy');
    expect(paths).not.toHaveBeenCalled();
    expect(
      ProtobufUtils.extractOAuthTokenDetailsFromUnifiedStateEntry(
        result.data['antigravityUnifiedStateSync.oauthToken']!,
      ),
    ).toEqual({
      accessToken: 'cli-access',
      refreshToken: 'cli-refresh',
      expiryTimestamp: 1900000000,
      idToken: 'cli-id',
      isGcpTos: false,
    });
  });

  describe('getCurrentAccountInfo', () => {
    it('prioritizes unified OAuth idToken email over stale legacy antigravityAuthStatus', () => {
      const idToken = `header.${Buffer.from(
        JSON.stringify({ email: 'unified@example.com', name: 'Unified User' }),
      ).toString('base64url')}.signature`;
      const oauth = ProtobufUtils.createUnifiedOAuthToken(
        'access',
        'refresh',
        1900000000,
        false,
        idToken,
      );
      values.set('antigravityUnifiedStateSync.oauthToken', oauth);
      values.set(
        'antigravityAuthStatus',
        JSON.stringify({ email: 'stale-legacy@example.com', name: 'Stale' }),
      );

      const info = getCurrentAccountInfo('ide');

      expect(info).toEqual({
        email: 'unified@example.com',
        name: 'Unified User',
        isAuthenticated: true,
      });
    });

    it('reads unified userStatus email when idToken is absent, overriding stale legacy keys', () => {
      const user = ProtobufUtils.createUnifiedStateEntry(
        'userStatusSentinelKey',
        ProtobufUtils.createMinimalUserStatusPayload('userstatus@example.com'),
      );
      values.set('antigravityUnifiedStateSync.userStatus', user);
      values.set(
        'antigravityAuthStatus',
        JSON.stringify({ email: 'stale-legacy@example.com', name: 'Stale' }),
      );

      const info = getCurrentAccountInfo('ide');

      expect(info).toEqual({
        email: 'userstatus@example.com',
        name: '',
        isAuthenticated: true,
      });
    });

    it.each([undefined, '', ' \t '])(
      'reads field 7 when userStatus field 3 is absent or blank (%j)',
      (field3) => {
        const payload = new Uint8Array([
          ...(field3 === undefined ? [] : ProtobufUtils.encodeStringField(3, field3)),
          ...ProtobufUtils.encodeStringField(7, 'field7@example.invalid'),
        ]);
        values.set(
          'antigravityUnifiedStateSync.userStatus',
          ProtobufUtils.createUnifiedStateEntry('userStatusSentinelKey', payload),
        );
        values.set(
          'antigravityAuthStatus',
          JSON.stringify({ email: 'stale@example.invalid', name: 'Stale' }),
        );

        expect(getCurrentAccountInfo('ide')).toEqual({
          email: 'field7@example.invalid',
          name: '',
          isAuthenticated: true,
        });
      },
    );

    it('falls back to legacy account info when unified userStatus is corrupt', () => {
      values.set('antigravityUnifiedStateSync.userStatus', 'not-protobuf');
      values.set(
        'antigravityAuthStatus',
        JSON.stringify({ email: 'legacy@example.invalid', name: 'Legacy' }),
      );

      expect(getCurrentAccountInfo('ide')).toEqual({
        email: 'legacy@example.invalid',
        name: 'Legacy',
        isAuthenticated: true,
      });
    });

    it('falls back to legacy antigravityAuthStatus when unified keys are absent', () => {
      values.set(
        'antigravityAuthStatus',
        JSON.stringify({ email: 'legacy@example.com', name: 'Legacy User' }),
      );

      const info = getCurrentAccountInfo('ide');

      expect(info).toEqual({
        email: 'legacy@example.com',
        name: 'Legacy User',
        isAuthenticated: true,
      });
    });
  });
});
