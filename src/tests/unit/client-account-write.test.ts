import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  prepareClientAccountWrite,
  resolveClientAccountStorage,
} from '@/modules/antigravity-runtime/credentials/clientAccountWrite';
import { getAntigravityDbPaths } from '@/shared/platform/paths';
import { getAntigravityVersion } from '@/modules/antigravity-runtime/utils/antigravityVersion';
import { ProtobufUtils } from '@/shared/serialization/protobuf';
import type { ClientAccountCredentials } from '@/modules/antigravity-runtime';
import {
  readAntigravityCredentialStoreToken,
  writeAntigravityCredentialStoreToken,
} from '@/modules/antigravity-runtime/credentials/antigravityCredentialStore';

const state = vi.hoisted(() => ({
  rows: new Map<string, string>(),
  backups: vi.fn(async (_path: string) => undefined),
  opens: vi.fn(),
  failKey: '',
}));
vi.mock('@/shared/platform/paths', () => ({
  getAntigravityDbPaths: vi.fn(() => ['/fixture/state.vscdb']),
}));
vi.mock('@/modules/antigravity-runtime/utils/antigravityVersion', () => ({
  getAntigravityVersion: vi.fn(async () => ({ shortVersion: '2.18.1', bundleVersion: '2.18.1' })),
  isCredentialStoreVersion: (version: { shortVersion: string }) =>
    Number(version.shortVersion.split('.')[0]) >= 2,
}));
vi.mock('@/modules/antigravity-runtime/credentials/antigravityCredentialStore', () => ({
  writeAntigravityCredentialStoreToken: vi.fn(),
  readAntigravityCredentialStoreToken: vi.fn(),
}));
vi.mock('drizzle-orm', async (original) => ({
  ...(await original<typeof import('drizzle-orm')>()),
  eq: (_column: unknown, value: string) => ({ key: value }),
}));
vi.mock('@/shared/persistence/database/dbConnection', () => {
  const db = {
    select: () => ({
      from: () => ({
        where: (condition: { key: string }) => ({
          all: () =>
            state.rows.has(condition.key) ? [{ value: state.rows.get(condition.key) }] : [],
        }),
      }),
    }),
    insert: () => ({
      values: (row: { key: string; value: string }) => ({
        onConflictDoUpdate: () => ({
          run: () => {
            if (state.failKey === row.key) {
              throw new Error('write failed');
            }
            state.rows.set(row.key, row.value);
          },
        }),
      }),
    }),
    delete: () => ({
      where: (condition: { key: string }) => ({ run: () => state.rows.delete(condition.key) }),
    }),
  };
  return {
    openDrizzleConnection: (file: string) => {
      state.opens(file);
      return {
        raw: { close: vi.fn(), backup: state.backups, exec: vi.fn() },
        orm: {
          ...db,
          transaction: (write: (transaction: typeof db) => void) => {
            const before = new Map(state.rows);
            try {
              write(db);
            } catch (error) {
              state.rows = before;
              throw error;
            }
          },
        },
      };
    },
  };
});

const credentials: ClientAccountCredentials = {
  email: 'fixture@example.org',
  name: 'Fixture',
  token: {
    access_token: 'access',
    refresh_token: 'refresh',
    expiry_timestamp: 1800000000,
    id_token: 'id-token',
    project_id: 'project-a',
    is_gcp_tos: true,
  },
};
beforeEach(() => {
  vi.clearAllMocks();
  state.rows.clear();
  state.failKey = '';
  vi.spyOn(fs, 'existsSync').mockReturnValue(true);
  vi.spyOn(fs, 'accessSync').mockImplementation(() => undefined);
  vi.spyOn(fs, 'mkdirSync').mockImplementation(() => undefined);
  vi.spyOn(fs, 'chmodSync').mockImplementation(() => undefined);
  vi.mocked(getAntigravityDbPaths).mockReturnValue(['/fixture/state.vscdb']);
  vi.mocked(getAntigravityVersion).mockResolvedValue({
    shortVersion: '2.18.1',
    bundleVersion: '2.18.1',
  });
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('client account destination', () => {
  it('confirms complete native credentials and rejects a stale readback', async () => {
    const prepared = await prepareClientAccountWrite(credentials, 'classic');
    vi.mocked(readAntigravityCredentialStoreToken).mockResolvedValue({
      accessToken: 'access',
      refreshToken: 'refresh',
      expiryTimestamp: 1800000000,
      idToken: 'id-token',
      projectId: 'project-a',
    });
    await prepared.write();
    expect(writeAntigravityCredentialStoreToken).toHaveBeenCalledExactlyOnceWith(
      credentials.token,
      { syncClassicOAuthFile: true },
    );
    vi.mocked(readAntigravityCredentialStoreToken).mockResolvedValue({
      accessToken: 'old-access',
      refreshToken: 'refresh',
      expiryTimestamp: 1800000000,
    });
    await expect(prepared.write()).rejects.toThrow('could not be confirmed');
  });
  it('routes IDE, CLI and Classic versions without old-format or engine guesses', async () => {
    expect(await resolveClientAccountStorage('ide')).toBe('sqlite');
    expect(await resolveClientAccountStorage('agy')).toBe('credential-store');
    expect(getAntigravityVersion).not.toHaveBeenCalled();
    expect(await resolveClientAccountStorage('classic')).toBe('credential-store');
    vi.mocked(getAntigravityVersion).mockResolvedValue({
      shortVersion: '1.107.0',
      bundleVersion: '1.107.0',
    });
    expect(await resolveClientAccountStorage('classic')).toBe('sqlite');
  });
  it('uses only the selected installation database when product version is unavailable', async () => {
    vi.mocked(getAntigravityVersion).mockRejectedValue(new Error('missing version'));
    expect(await resolveClientAccountStorage('classic', { userDataDir: '/fixture/data' })).toBe(
      'sqlite',
    );
    expect(getAntigravityDbPaths).toHaveBeenCalledWith('classic', { userDataDir: '/fixture/data' });
    vi.mocked(fs.existsSync).mockReturnValue(false);
    expect(await resolveClientAccountStorage('classic')).toBe('credential-store');
  });
  it('rejects credentials and inaccessible data paths before writing', async () => {
    await expect(prepareClientAccountWrite({ ...credentials, email: '' }, 'ide')).rejects.toThrow(
      'identity',
    );
    vi.mocked(fs.accessSync).mockImplementation(() => {
      throw new Error('access denied');
    });
    await expect(prepareClientAccountWrite(credentials, 'ide')).rejects.toThrow('access denied');
    expect(state.opens).not.toHaveBeenCalled();
  });
});

describe('unified client account writes', () => {
  it('preserves unrelated OAuth topic rows, writes complete identity and removes stale state', async () => {
    const preserved = ProtobufUtils.createUnifiedTopicEntry(
      'otherSentinel',
      new Uint8Array([4, 5, 6]),
    );
    state.rows.set(
      'antigravityUnifiedStateSync.oauthToken',
      Buffer.from(preserved).toString('base64'),
    );
    state.rows.set('jetskiStateSync.agentManagerInitState', 'previous-user');
    state.rows.set('google.antigravity', 'previous-cache');
    state.rows.set('workspace.unrelated', 'keep');
    const prepared = await prepareClientAccountWrite(credentials, 'ide');
    await prepared.write();
    const oauth = state.rows.get('antigravityUnifiedStateSync.oauthToken')!;
    expect(
      ProtobufUtils.decodeUnifiedStateTopicEntries(new Uint8Array(Buffer.from(oauth, 'base64')))[0],
    ).toEqual({ sentinelKey: 'otherSentinel', payload: new Uint8Array([4, 5, 6]) });
    expect(ProtobufUtils.extractOAuthTokenDetailsFromUnifiedStateEntry(oauth)).toEqual({
      accessToken: 'access',
      refreshToken: 'refresh',
      expiryTimestamp: 1800000000,
      idToken: 'id-token',
      isGcpTos: true,
    });
    expect(state.rows.has('jetskiStateSync.agentManagerInitState')).toBe(false);
    expect(state.rows.has('google.antigravity')).toBe(false);
    expect(state.rows.get('workspace.unrelated')).toBe('keep');
    expect(state.rows.get('antigravityOnboarding')).toBe('true');
  });
  it('clears the previous project, captures the destination once and preserves one recovery snapshot', async () => {
    state.rows.set('antigravityUnifiedStateSync.enterprisePreferences', 'previous-project');
    const input = structuredClone(credentials);
    delete input.token.project_id;
    const prepared = await prepareClientAccountWrite(input, 'ide');
    input.token.access_token = 'changed-after-preparation';
    vi.mocked(getAntigravityDbPaths).mockReturnValue(['/other/state.vscdb']);
    await prepared.write();
    await prepared.write();
    expect(state.opens.mock.calls).toEqual([
      ['/fixture/state.vscdb'],
      ['/fixture/state.vscdb'],
      ['/fixture/state.vscdb'],
    ]);
    expect(state.backups).toHaveBeenCalledExactlyOnceWith(
      '/fixture/state.vscdb.account-switch.backup',
      expect.objectContaining({ progress: expect.any(Function) }),
    );
    expect(state.rows.has('antigravityUnifiedStateSync.enterprisePreferences')).toBe(false);
    expect(
      ProtobufUtils.extractOAuthTokenDetailsFromUnifiedStateEntry(
        state.rows.get('antigravityUnifiedStateSync.oauthToken')!,
      )?.accessToken,
    ).toBe('access');
  });
  it('rolls back all account writes when the primary store fails and never writes a recovery copy', async () => {
    state.rows.set('workspace.unrelated', 'keep');
    const previous = new Map(state.rows);
    state.failKey = 'antigravityAuthStatus';
    const prepared = await prepareClientAccountWrite(credentials, 'ide');
    await expect(prepared.write()).rejects.toThrow('write failed');
    expect(state.rows).toEqual(previous);
    expect(state.opens.mock.calls).toEqual([['/fixture/state.vscdb'], ['/fixture/state.vscdb']]);
  });
});
