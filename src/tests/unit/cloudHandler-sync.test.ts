import fs from 'fs';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ProtobufUtils } from '../../utils/protobuf';
import { CloudAccountRepo } from '../../ipc/database/cloudHandler';
import type { UserInfo } from '../../services/GoogleAPIService';

let mockData: Record<string, string>;
let busyOnFirstGet = false;
let getCallCount = 0;
let runCalls: Array<{ sql: string; args: unknown[] }>;
interface MockOrm {
  select: () => {
    from: () => {
      where: (condition: { __key?: string }) => { all: () => Array<{ value: string }> };
    };
  };
  insert: () => {
    values: (values: { key: string; value: string }) => {
      onConflictDoUpdate: () => { run: () => { changes: number } };
    };
  };
  update: () => {
    set: (values: { value?: string }) => {
      where: (condition: { __key?: string }) => { run: () => { changes: number } };
    };
  };
  delete: () => {
    where: (condition: { __key?: string }) => { run: () => { changes: number } };
  };
  transaction: (fn: (tx: MockOrm) => void) => void;
}

let mockOrm: MockOrm;

function createMockUserInfo(email: string, name: string): UserInfo {
  return {
    id: `id-${email}`,
    email,
    verified_email: true,
    name,
    given_name: name,
    family_name: 'User',
    picture: '',
  };
}

vi.mock('drizzle-orm', () => ({
  eq: (_column: unknown, value: string) => ({ __key: value }),
  desc: (value: unknown) => value,
}));

vi.mock('../../ipc/database/dbConnection', () => ({
  openDrizzleConnection: () => ({
    raw: { close: vi.fn() },
    orm: mockOrm,
  }),
}));

vi.mock('../../utils/paths', () => ({
  getAntigravityDbPaths: () => ['mock-db'],
  getCloudAccountsDbPath: () => 'mock-cloud-db',
}));

vi.mock('../../utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../../services/GoogleAPIService', () => ({
  GoogleAPIService: {
    getUserInfo: vi.fn(),
  },
}));

describe('CloudAccountRepo.syncFromIDE', () => {
  beforeEach(() => {
    mockData = {};
    busyOnFirstGet = false;
    getCallCount = 0;
    runCalls = [];
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    mockOrm = {
      select: () => ({
        from: () => ({
          where: (condition: { __key?: string }) => ({
            all: () => {
              getCallCount += 1;
              if (busyOnFirstGet && getCallCount === 1) {
                const error = new Error('SQLITE_BUSY');
                (error as { code?: string }).code = 'SQLITE_BUSY';
                throw error;
              }
              const key = condition?.__key ?? '';
              const value = mockData[key];
              if (value === undefined) {
                return [];
              }
              return [{ value }];
            },
          }),
        }),
      }),
      insert: () => ({
        values: (values: { key: string; value: string }) => ({
          onConflictDoUpdate: () => ({
            run: () => {
              runCalls.push({ sql: 'insert', args: [values] });
              return { changes: 1 };
            },
          }),
        }),
      }),
      update: () => ({
        set: (values: { value?: string }) => ({
          where: (condition: { __key?: string }) => ({
            run: () => {
              runCalls.push({ sql: 'update', args: [values, condition] });
              return { changes: 1 };
            },
          }),
        }),
      }),
      delete: () => ({
        where: (condition: { __key?: string }) => ({
          run: () => {
            runCalls.push({ sql: 'delete', args: [condition] });
            return { changes: 1 };
          },
        }),
      }),
      transaction: (fn: (tx: typeof mockOrm) => void) => {
        fn(mockOrm);
      },
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should prefer unified oauth token when present', async () => {
    const accessToken = 'access-new';
    const refreshToken = 'refresh-new';
    const unifiedB64 = ProtobufUtils.createUnifiedOAuthToken(accessToken, refreshToken, 1700000000);

    const oldB64 = Buffer.from(
      ProtobufUtils.createOAuthTokenInfo('access-old', 'refresh-old', 1700000000),
    ).toString('base64');

    mockData['antigravityUnifiedStateSync.oauthToken'] = unifiedB64;
    mockData['jetskiStateSync.agentManagerInitState'] = oldB64;

    const { GoogleAPIService } = await import('../../services/GoogleAPIService');
    vi.mocked(GoogleAPIService.getUserInfo).mockResolvedValue(
      createMockUserInfo('new@example.com', 'New User'),
    );

    vi.spyOn(CloudAccountRepo, 'getAccounts').mockResolvedValue([]);
    vi.spyOn(CloudAccountRepo, 'addAccount').mockResolvedValue();

    const account = await CloudAccountRepo.syncFromIDE();

    expect(GoogleAPIService.getUserInfo).toHaveBeenCalledWith(accessToken);
    expect(account?.email).toBe('new@example.com');
  });

  it('should fall back to old oauth token when unified is missing', async () => {
    const accessToken = 'access-old';
    const refreshToken = 'refresh-old';
    const oldB64 = Buffer.from(
      ProtobufUtils.createOAuthTokenInfo(accessToken, refreshToken, 1700000000),
    ).toString('base64');

    mockData['jetskiStateSync.agentManagerInitState'] = oldB64;

    const { GoogleAPIService } = await import('../../services/GoogleAPIService');
    vi.mocked(GoogleAPIService.getUserInfo).mockResolvedValue(
      createMockUserInfo('old@example.com', 'Old User'),
    );

    vi.spyOn(CloudAccountRepo, 'getAccounts').mockResolvedValue([]);
    vi.spyOn(CloudAccountRepo, 'addAccount').mockResolvedValue();

    const account = await CloudAccountRepo.syncFromIDE();

    expect(GoogleAPIService.getUserInfo).toHaveBeenCalledWith(accessToken);
    expect(account?.email).toBe('old@example.com');
  });

  it('should retry when sqlite is busy', async () => {
    busyOnFirstGet = true;
    const accessToken = 'access-retry';
    const refreshToken = 'refresh-retry';
    const oldB64 = Buffer.from(
      ProtobufUtils.createOAuthTokenInfo(accessToken, refreshToken, 1700000000),
    ).toString('base64');

    mockData['jetskiStateSync.agentManagerInitState'] = oldB64;

    const { GoogleAPIService } = await import('../../services/GoogleAPIService');
    vi.mocked(GoogleAPIService.getUserInfo).mockResolvedValue(
      createMockUserInfo('retry@example.com', 'Retry User'),
    );

    vi.spyOn(CloudAccountRepo, 'getAccounts').mockResolvedValue([]);
    vi.spyOn(CloudAccountRepo, 'addAccount').mockResolvedValue();

    const account = await CloudAccountRepo.syncFromIDE();

    expect(GoogleAPIService.getUserInfo).toHaveBeenCalledWith(accessToken);
    expect(account?.email).toBe('retry@example.com');
  });

  it('should prefer new format when capability detection finds unified key', async () => {
    vi.resetModules();
    vi.doMock('../../utils/antigravityVersion', () => ({
      getAntigravityVersion: () => {
        throw new Error('version detection failed');
      },
      isNewVersion: () => false,
    }));

    const { CloudAccountRepo: RepoWithMock } = await import('../../ipc/database/cloudHandler');
    const accessToken = 'access-new';
    const refreshToken = 'refresh-new';

    mockData['antigravityUnifiedStateSync.oauthToken'] = 'exists';
    mockData['jetskiStateSync.agentManagerInitState'] = 'exists-old';

    RepoWithMock.injectCloudToken({
      id: 'id',
      provider: 'google',
      email: 'test@example.com',
      name: 'Test',
      avatar_url: '',
      token: {
        access_token: accessToken,
        refresh_token: refreshToken,
        expires_in: 3600,
        expiry_timestamp: 1700000000,
        token_type: 'Bearer',
        email: 'test@example.com',
      },
      created_at: 1700000000,
      last_used: 1700000000,
      status: 'active',
      is_active: true,
    });

    const updatedOldKey = runCalls.some(
      (call) =>
        call.sql === 'update' &&
        (call.args[1] as { __key?: string } | undefined)?.__key ===
          'jetskiStateSync.agentManagerInitState',
    );
    const wroteUnifiedKey = runCalls.some(
      (call) =>
        call.sql === 'insert' &&
        (call.args[0] as { key?: string })?.key === 'antigravityUnifiedStateSync.oauthToken',
    );

    expect(wroteUnifiedKey).toBe(true);
    expect(updatedOldKey).toBe(false);
  });
});
