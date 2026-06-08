import fs from 'fs';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ProtobufUtils } from '../../shared/serialization/protobuf';
import { CloudAccountRepo } from '@/modules/cloud-account/persistence/cloudHandler';
import { writeAntigravityCredentialStoreToken } from '@/modules/cloud-account/persistence/antigravityCredentialStore';
import type { UserInfo } from '@/modules/cloud-account/services/GoogleAPIService';
import { toSyncLocalAccountORPCError } from '@/modules/cloud-account/ipc/router';

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

vi.mock('@/shared/persistence/database/dbConnection', () => ({
  openDrizzleConnection: () => ({
    raw: { close: vi.fn() },
    orm: mockOrm,
  }),
}));

vi.mock('../../shared/platform/paths', () => ({
  getAntigravityDbPaths: () => ['mock-db'],
  getCloudAccountsDbPath: () => 'mock-cloud-db',
  refreshAntigravityProcessCache: () => Promise.resolve(),
}));

vi.mock('../../shared/logging/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('@/modules/cloud-account/services/GoogleAPIService', () => ({
  GoogleAPIService: {
    getUserInfo: vi.fn(),
  },
}));

vi.mock('@/modules/cloud-account/persistence/antigravityCredentialStore', () => ({
  writeAntigravityCredentialStoreToken: vi.fn(),
}));

describe('CloudAccountRepo.syncFromIde', () => {
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
    const unifiedB64 = ProtobufUtils.createUnifiedOAuthToken(
      accessToken,
      refreshToken,
      1700000000,
      true,
      'id-new',
    );

    const oldB64 = Buffer.from(
      ProtobufUtils.createOAuthTokenInfo('access-old', 'refresh-old', 1700000000),
    ).toString('base64');

    mockData['antigravityUnifiedStateSync.oauthToken'] = unifiedB64;
    mockData['jetskiStateSync.agentManagerInitState'] = oldB64;

    const { GoogleAPIService } = await import('@/modules/cloud-account/services/GoogleAPIService');
    vi.mocked(GoogleAPIService.getUserInfo).mockResolvedValue(
      createMockUserInfo('new@example.com', 'New User'),
    );

    vi.spyOn(CloudAccountRepo, 'getAccounts').mockResolvedValue([]);
    vi.spyOn(CloudAccountRepo, 'addAccount').mockResolvedValue();

    const account = await CloudAccountRepo.syncFromIde();

    expect(GoogleAPIService.getUserInfo).toHaveBeenCalledWith(accessToken);
    expect(account?.email).toBe('new@example.com');
    expect(account?.token.id_token).toBe('id-new');
    expect(account?.token.is_gcp_tos).toBe(false);
  });

  it('reads enterprise project preference from IDE unified state when syncing new account', async () => {
    const accessToken = 'access-enterprise';
    const refreshToken = 'refresh-enterprise';
    const unifiedB64 = ProtobufUtils.createUnifiedOAuthToken(accessToken, refreshToken, 1700000000);
    const projectPayload = ProtobufUtils.createStringValuePayload('enterprise-project-1');
    const enterprisePreferenceB64 = ProtobufUtils.createUnifiedStateEntry(
      'enterpriseGcpProjectId',
      projectPayload,
    );

    mockData['antigravityUnifiedStateSync.oauthToken'] = unifiedB64;
    mockData['antigravityUnifiedStateSync.enterprisePreferences'] = enterprisePreferenceB64;

    const { GoogleAPIService } = await import('@/modules/cloud-account/services/GoogleAPIService');
    vi.mocked(GoogleAPIService.getUserInfo).mockResolvedValue(
      createMockUserInfo('enterprise@example.com', 'Enterprise User'),
    );

    vi.spyOn(CloudAccountRepo, 'getAccounts').mockResolvedValue([]);
    vi.spyOn(CloudAccountRepo, 'addAccount').mockResolvedValue();

    const account = await CloudAccountRepo.syncFromIde();

    expect(GoogleAPIService.getUserInfo).toHaveBeenCalledWith(accessToken);
    expect(account?.email).toBe('enterprise@example.com');
    expect(account?.token.project_id).toBe('enterprise-project-1');
  });

  it('should fall back to old oauth token when unified is missing', async () => {
    const accessToken = 'access-old';
    const refreshToken = 'refresh-old';
    const oldB64 = Buffer.from(
      ProtobufUtils.createOAuthTokenInfo(accessToken, refreshToken, 1700000000),
    ).toString('base64');

    mockData['jetskiStateSync.agentManagerInitState'] = oldB64;

    const { GoogleAPIService } = await import('@/modules/cloud-account/services/GoogleAPIService');
    vi.mocked(GoogleAPIService.getUserInfo).mockResolvedValue(
      createMockUserInfo('old@example.com', 'Old User'),
    );

    vi.spyOn(CloudAccountRepo, 'getAccounts').mockResolvedValue([]);
    vi.spyOn(CloudAccountRepo, 'addAccount').mockResolvedValue();

    const account = await CloudAccountRepo.syncFromIde();

    expect(GoogleAPIService.getUserInfo).toHaveBeenCalledWith(accessToken);
    expect(account?.email).toBe('old@example.com');
  });

  it('preserves existing token metadata and proxy settings when syncing existing account', async () => {
    const accessToken = 'access-updated';
    const refreshToken = 'refresh-updated';
    const oldB64 = Buffer.from(
      ProtobufUtils.createOAuthTokenInfo(accessToken, refreshToken, 1700000000),
    ).toString('base64');

    mockData['jetskiStateSync.agentManagerInitState'] = oldB64;

    const { GoogleAPIService } = await import('@/modules/cloud-account/services/GoogleAPIService');
    vi.mocked(GoogleAPIService.getUserInfo).mockResolvedValue(
      createMockUserInfo('existing@example.com', 'Existing User'),
    );

    const existingAccount = {
      id: 'existing-id',
      provider: 'google' as const,
      email: 'existing@example.com',
      name: 'Existing User',
      avatar_url: 'https://example.com/avatar.png',
      token: {
        access_token: 'old-access',
        refresh_token: 'old-refresh',
        expires_in: 3600,
        expiry_timestamp: 1699999999,
        token_type: 'Bearer',
        email: 'existing@example.com',
        project_id: 'project-keep',
        oauth_client_key: 'custom-client',
        session_id: 'session-keep',
        upstream_proxy_url: 'http://127.0.0.1:8080',
      },
      quota: undefined,
      device_profile: undefined,
      device_history: undefined,
      created_at: 1690000000,
      last_used: 1690000100,
      status: 'active' as const,
      is_active: false,
      proxy_url: 'http://127.0.0.1:7890',
    };

    vi.spyOn(CloudAccountRepo, 'getAccounts').mockResolvedValue([existingAccount]);
    const addAccountSpy = vi.spyOn(CloudAccountRepo, 'addAccount').mockResolvedValue();

    const account = await CloudAccountRepo.syncFromIde();

    expect(account?.id).toBe('existing-id');
    expect(account?.token.project_id).toBe('project-keep');
    expect(account?.token.oauth_client_key).toBe('custom-client');
    expect(account?.token.session_id).toBe('session-keep');
    expect(account?.token.upstream_proxy_url).toBe('http://127.0.0.1:8080');
    expect(account?.proxy_url).toBe('http://127.0.0.1:7890');

    expect(addAccountSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'existing-id',
        token: expect.objectContaining({
          access_token: accessToken,
          refresh_token: refreshToken,
          project_id: 'project-keep',
          oauth_client_key: 'custom-client',
        }),
        proxy_url: 'http://127.0.0.1:7890',
      }),
    );
  });

  it('should recover project_id from IDE enterprise preferences when existing project_id is blank', async () => {
    const accessToken = 'access-blank-project';
    const refreshToken = 'refresh-blank-project';
    const unifiedB64 = ProtobufUtils.createUnifiedOAuthToken(
      accessToken,
      refreshToken,
      1700000000,
      true,
    );
    const enterprisePreferenceB64 = ProtobufUtils.createUnifiedStateEntry(
      'enterpriseGcpProjectId',
      ProtobufUtils.createStringValuePayload('enterprise-project-recovered'),
    );

    mockData['antigravityUnifiedStateSync.oauthToken'] = unifiedB64;
    mockData['antigravityUnifiedStateSync.enterprisePreferences'] = enterprisePreferenceB64;

    const { GoogleAPIService } = await import('@/modules/cloud-account/services/GoogleAPIService');
    vi.mocked(GoogleAPIService.getUserInfo).mockResolvedValue(
      createMockUserInfo('existing@example.com', 'Existing User'),
    );

    const existingAccount = {
      id: 'existing-id',
      provider: 'google' as const,
      email: 'existing@example.com',
      name: 'Existing User',
      avatar_url: 'https://example.com/avatar.png',
      token: {
        access_token: 'old-access',
        refresh_token: 'old-refresh',
        expires_in: 3600,
        expiry_timestamp: 1699999999,
        token_type: 'Bearer',
        email: 'existing@example.com',
        project_id: '   ',
        oauth_client_key: 'custom-client',
      },
      quota: undefined,
      device_profile: undefined,
      device_history: undefined,
      created_at: 1690000000,
      last_used: 1690000100,
      status: 'active' as const,
      is_active: false,
      proxy_url: 'http://127.0.0.1:7890',
    };

    vi.spyOn(CloudAccountRepo, 'getAccounts').mockResolvedValue([existingAccount]);
    const addAccountSpy = vi.spyOn(CloudAccountRepo, 'addAccount').mockResolvedValue();

    const account = await CloudAccountRepo.syncFromIde();

    expect(account?.token.project_id).toBe('enterprise-project-recovered');
    expect(addAccountSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        token: expect.objectContaining({
          project_id: 'enterprise-project-recovered',
        }),
      }),
    );
  });

  it('should reset stale blocked status after successful IDE resync', async () => {
    const accessToken = 'access-status-reset';
    const refreshToken = 'refresh-status-reset';
    const oldB64 = Buffer.from(
      ProtobufUtils.createOAuthTokenInfo(accessToken, refreshToken, 1700000000),
    ).toString('base64');

    mockData['jetskiStateSync.agentManagerInitState'] = oldB64;

    const { GoogleAPIService } = await import('@/modules/cloud-account/services/GoogleAPIService');
    vi.mocked(GoogleAPIService.getUserInfo).mockResolvedValue(
      createMockUserInfo('existing@example.com', 'Existing User'),
    );

    const existingAccount = {
      id: 'existing-id',
      provider: 'google' as const,
      email: 'existing@example.com',
      name: 'Existing User',
      avatar_url: 'https://example.com/avatar.png',
      token: {
        access_token: 'old-access',
        refresh_token: 'old-refresh',
        expires_in: 3600,
        expiry_timestamp: 1699999999,
        token_type: 'Bearer',
        email: 'existing@example.com',
      },
      quota: undefined,
      device_profile: undefined,
      device_history: undefined,
      created_at: 1690000000,
      last_used: 1690000100,
      status: 'rate_limited' as const,
      status_reason: 'RESOURCE_EXHAUSTED',
      is_active: false,
      proxy_url: 'http://127.0.0.1:7890',
    };

    vi.spyOn(CloudAccountRepo, 'getAccounts').mockResolvedValue([existingAccount]);
    const addAccountSpy = vi.spyOn(CloudAccountRepo, 'addAccount').mockResolvedValue();

    const account = await CloudAccountRepo.syncFromIde();

    expect(account?.status).toBe('active');
    expect(account?.status_reason).toBeUndefined();
    expect(addAccountSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'active',
        status_reason: undefined,
      }),
    );
  });

  it('should retry when sqlite is busy', async () => {
    busyOnFirstGet = true;
    const accessToken = 'access-retry';
    const refreshToken = 'refresh-retry';
    const oldB64 = Buffer.from(
      ProtobufUtils.createOAuthTokenInfo(accessToken, refreshToken, 1700000000),
    ).toString('base64');

    mockData['jetskiStateSync.agentManagerInitState'] = oldB64;

    const { GoogleAPIService } = await import('@/modules/cloud-account/services/GoogleAPIService');
    vi.mocked(GoogleAPIService.getUserInfo).mockResolvedValue(
      createMockUserInfo('retry@example.com', 'Retry User'),
    );

    vi.spyOn(CloudAccountRepo, 'getAccounts').mockResolvedValue([]);
    vi.spyOn(CloudAccountRepo, 'addAccount').mockResolvedValue();

    const account = await CloudAccountRepo.syncFromIde();

    expect(GoogleAPIService.getUserInfo).toHaveBeenCalledWith(accessToken);
    expect(account?.email).toBe('retry@example.com');
  });

  it('should inject both formats when version detection fails', async () => {
    vi.resetModules();
    vi.doMock('@/modules/antigravity-runtime/utils/antigravityVersion', () => ({
      getAntigravityVersion: () => {
        throw new Error('version detection failed');
      },
      isCredentialStoreVersion: () => false,
      isNewVersion: () => false,
    }));

    const { CloudAccountRepo: RepoWithMock } =
      await import('@/modules/cloud-account/persistence/cloudHandler');
    const accessToken = 'access-new';
    const refreshToken = 'refresh-new';

    mockData['antigravityUnifiedStateSync.oauthToken'] = 'exists';
    mockData['jetskiStateSync.agentManagerInitState'] = Buffer.from(
      ProtobufUtils.createOAuthTokenInfo('old-access', 'old-refresh', 1699999999),
    ).toString('base64');

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
    expect(updatedOldKey).toBe(true);
  });

  it('should keep pre-2.0 product versions out of the credential store', async () => {
    vi.resetModules();
    vi.doMock('@/modules/antigravity-runtime/utils/antigravityVersion', () => ({
      getAntigravityVersion: () => ({
        shortVersion: '1.99.9',
        bundleVersion: '1.99.9',
      }),
      isCredentialStoreVersion: () => false,
      isNewVersion: () => true,
    }));

    const { CloudAccountRepo: RepoWithMock } =
      await import('@/modules/cloud-account/persistence/cloudHandler');

    expect(RepoWithMock.shouldInjectTokenIntoCredentialStore('classic')).toBe(false);
  });

  it('should allow the known Linux Chromium version output workaround', async () => {
    vi.resetModules();
    vi.doMock('@/modules/antigravity-runtime/utils/antigravityVersion', () => ({
      getAntigravityVersion: () => ({
        shortVersion: '1.107.0',
        bundleVersion: '1.107.0',
      }),
      isCredentialStoreVersion: () => false,
      isNewVersion: () => true,
    }));

    const { CloudAccountRepo: RepoWithMock } =
      await import('@/modules/cloud-account/persistence/cloudHandler');

    expect(RepoWithMock.shouldInjectTokenIntoCredentialStore('classic')).toBe(true);
  });

  it('should route Classic Antigravity 2.0+ token injection to credential store', () => {
    const shouldInjectTokenIntoCredentialStoreSpy = vi
      .spyOn(CloudAccountRepo, 'shouldInjectTokenIntoCredentialStore')
      .mockReturnValueOnce(true);
    const injectCloudTokenSpy = vi.spyOn(CloudAccountRepo, 'injectCloudToken');

    const account = {
      id: 'id',
      provider: 'google' as const,
      email: 'test@example.com',
      name: 'Test',
      avatar_url: '',
      token: {
        access_token: 'access',
        refresh_token: 'refresh',
        expires_in: 3600,
        expiry_timestamp: 1700000000,
        token_type: 'Bearer',
        email: 'test@example.com',
      },
      created_at: 1700000000,
      last_used: 1700000000,
      status: 'active' as const,
      is_active: true,
    };

    expect(CloudAccountRepo.injectCloudTokenWithStorageStrategy(account)).toBe('credential-store');
    expect(shouldInjectTokenIntoCredentialStoreSpy).toHaveBeenCalledWith(undefined);
    expect(writeAntigravityCredentialStoreToken).toHaveBeenCalledWith(account.token);
    expect(injectCloudTokenSpy).not.toHaveBeenCalled();
  });

  it('should route Antigravity IDE token injection to SQLite target', () => {
    vi.spyOn(CloudAccountRepo, 'shouldInjectTokenIntoCredentialStore').mockReturnValueOnce(false);
    const injectCloudTokenSpy = vi
      .spyOn(CloudAccountRepo, 'injectCloudToken')
      .mockImplementationOnce(() => undefined);

    const account = {
      id: 'id',
      provider: 'google' as const,
      email: 'test@example.com',
      name: 'Test',
      avatar_url: '',
      token: {
        access_token: 'access',
        refresh_token: 'refresh',
        expires_in: 3600,
        expiry_timestamp: 1700000000,
        token_type: 'Bearer',
        email: 'test@example.com',
      },
      created_at: 1700000000,
      last_used: 1700000000,
      status: 'active' as const,
      is_active: true,
    };

    expect(CloudAccountRepo.injectCloudTokenWithStorageStrategy(account, 'ide')).toBe('sqlite');
    expect(injectCloudTokenSpy).toHaveBeenCalledWith(account, 'ide');
  });
});

describe('syncLocalAccount ORPC error mapping', () => {
  it('preserves re-login guidance as an actionable unauthorized error', () => {
    const error = toSyncLocalAccountORPCError(
      new Error(
        'Failed to validate token with Google API. The token may be expired. Please re-login in Antigravity IDE.',
      ),
    );

    expect(error.code).toBe('UNAUTHORIZED');
    expect(error.status).toBe(401);
    expect(error.message).toContain('Please re-login in Antigravity IDE');
  });
});

describe('cloud switch fail-fast path', () => {
  afterEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('should fail fast without rollback or forced restart when inject fails', async () => {
    vi.resetModules();

    const applyDeviceProfileMock = vi.fn();
    const startAntigravityMock = vi.fn(async () => undefined);
    const recordSwitchFailureMock = vi.fn();
    const recordSwitchSuccessMock = vi.fn();
    const updateTokenMock = vi.fn(async () => undefined);
    const refreshAccessTokenMock = vi.fn(async () => ({
      access_token: 'refreshed-access',
      expires_in: 3600,
      token_type: 'Bearer',
      oauth_client_key: 'custom_a',
    }));

    const account = {
      id: 'acc-1',
      email: 'cloud@test.dev',
      name: 'Cloud User',
      provider: 'google' as const,
      token: {
        access_token: 'access',
        refresh_token: 'refresh',
        expires_in: 3600,
        expiry_timestamp: Math.floor(Date.now() / 1000) + 3600,
        token_type: 'Bearer',
        email: 'cloud@test.dev',
      },
      created_at: Math.floor(Date.now() / 1000),
      last_used: Math.floor(Date.now() / 1000),
      device_profile: {
        machineId: 'target-machine',
        macMachineId: 'target-mac',
        devDeviceId: 'target-dev',
        sqmId: '{TARGET-SQM}',
      },
    };

    vi.doMock('@/modules/cloud-account/persistence/cloudHandler', () => ({
      CloudAccountRepo: {
        getAccount: vi.fn(async () => account),
        setDeviceBinding: vi.fn(),
        updateToken: updateTokenMock,
        shouldInjectTokenIntoCredentialStore: vi.fn(() => false),
        injectCloudTokenWithStorageStrategy: vi.fn(() => {
          throw new Error('inject_failed');
        }),
        updateLastUsed: vi.fn(),
        setActive: vi.fn(),
        getSetting: vi.fn(() => 'en'),
      },
    }));

    vi.doMock('@/modules/identity-profile/ipc/handler', () => ({
      applyDeviceProfile: applyDeviceProfileMock,
      ensureGlobalOriginalFromCurrentStorage: vi.fn(),
      generateDeviceProfile: vi.fn(() => account.device_profile),
      isIdentityProfileApplyEnabled: vi.fn(() => true),
      readCurrentDeviceProfile: vi.fn(() => ({
        machineId: 'prev-machine',
        macMachineId: 'prev-mac',
        devDeviceId: 'prev-dev',
        sqmId: '{PREV-SQM}',
      })),
    }));

    vi.doMock('@/modules/antigravity-runtime/ipc/handler', () => ({
      closeAntigravity: vi.fn(async () => undefined),
      startAntigravity: startAntigravityMock,
      _waitForProcessExit: vi.fn(async () => undefined),
    }));

    vi.doMock('@/modules/antigravity-runtime/switch/switchMetrics', () => ({
      recordSwitchFailure: recordSwitchFailureMock,
      recordSwitchSuccess: recordSwitchSuccessMock,
    }));

    vi.doMock('@/modules/app-shell/ipc/tray/handler', () => ({
      updateTrayMenu: vi.fn(),
    }));

    vi.doMock('../../shared/platform/paths', () => ({
      getAntigravityDbPaths: () => [],
      refreshAntigravityProcessCache: () => Promise.resolve(),
    }));

    vi.doMock('../../shared/logging/logger', () => ({
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      },
    }));

    vi.doMock('@/modules/cloud-account/services/GoogleAPIService', () => ({
      GoogleAPIService: {
        refreshAccessToken: refreshAccessTokenMock,
        normalizeRefreshedOAuthClientKey: vi.fn(
          (_currentToken: unknown, refreshedClientKey?: string) => refreshedClientKey,
        ),
      },
    }));

    vi.doMock('electron', () => ({
      shell: {
        openExternal: vi.fn(),
      },
    }));

    const { switchCloudAccount } = await import('@/modules/cloud-account/ipc/handler');
    await expect(switchCloudAccount('acc-1')).rejects.toThrow('Switch failed: inject_failed');

    expect(refreshAccessTokenMock).toHaveBeenCalledWith('refresh', undefined, undefined);
    expect(updateTokenMock).toHaveBeenCalledWith(
      'acc-1',
      expect.objectContaining({
        access_token: 'refreshed-access',
        expiry_timestamp: expect.any(Number),
      }),
    );
    expect(applyDeviceProfileMock).toHaveBeenCalledTimes(1);
    expect(applyDeviceProfileMock).toHaveBeenCalledWith(account.device_profile, undefined);
    expect(startAntigravityMock).not.toHaveBeenCalled();
    expect(recordSwitchFailureMock).toHaveBeenCalledWith(
      'cloud',
      'perform_switch_failed',
      expect.stringContaining('inject_failed'),
    );
    expect(recordSwitchSuccessMock).not.toHaveBeenCalled();
  });
});

describe('cloud oauth client key backfill', () => {
  afterEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('marks Classic active from target state when credential store mode has no SQLite account email', async () => {
    const accounts = [
      {
        id: 'acc-1',
        provider: 'google' as const,
        email: 'first@test.dev',
        token: {
          access_token: 'access-1',
          refresh_token: 'refresh-1',
          expires_in: 3600,
          expiry_timestamp: Math.floor(Date.now() / 1000) + 3600,
          token_type: 'Bearer',
          email: 'first@test.dev',
          oauth_client_key: 'custom_a',
        },
        created_at: Math.floor(Date.now() / 1000),
        last_used: Math.floor(Date.now() / 1000),
      },
      {
        id: 'acc-2',
        provider: 'google' as const,
        email: 'second@test.dev',
        token: {
          access_token: 'access-2',
          refresh_token: 'refresh-2',
          expires_in: 3600,
          expiry_timestamp: Math.floor(Date.now() / 1000) + 3600,
          token_type: 'Bearer',
          email: 'second@test.dev',
          oauth_client_key: 'custom_a',
        },
        created_at: Math.floor(Date.now() / 1000),
        last_used: Math.floor(Date.now() / 1000),
      },
    ];

    vi.doMock('@/modules/cloud-account/persistence/cloudHandler', () => ({
      CloudAccountRepo: {
        getAccounts: vi.fn(async () => accounts),
        updateToken: vi.fn(),
        shouldInjectTokenIntoCredentialStore: vi.fn(() => true),
        getActiveAccountIdForTarget: vi.fn((target: string) =>
          target === 'classic' ? 'acc-2' : '',
        ),
        getSetting: vi.fn((key: string, defaultValue: unknown) => {
          if (key === 'oauth_client_key_backfill_v1_done') {
            return true;
          }
          return defaultValue;
        }),
        setSetting: vi.fn(),
      },
    }));

    vi.doMock('@/modules/cloud-account/services/GoogleAPIService', () => ({
      GoogleAPIService: {
        setActiveOAuthClientKey: vi.fn(),
        getActiveOAuthClientKey: vi.fn(() => 'custom_a'),
      },
    }));

    vi.doMock('../../shared/logging/logger', () => ({
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      },
    }));
    vi.doMock('@/modules/app-shell/ipc/tray/handler', () => ({ updateTrayMenu: vi.fn() }));
    vi.doMock('@/modules/identity-profile/ipc/handler', () => ({
      ensureGlobalOriginalFromCurrentStorage: vi.fn(),
      generateDeviceProfile: vi.fn(),
      getStorageDirectoryPath: vi.fn(() => ''),
      isIdentityProfileApplyEnabled: vi.fn(() => false),
      loadGlobalOriginalProfile: vi.fn(),
      readCurrentDeviceProfile: vi.fn(),
      saveGlobalOriginalProfile: vi.fn(),
    }));
    vi.doMock('../../shared/platform/paths', () => ({
      getAntigravityDbPaths: () => [],
      refreshAntigravityProcessCache: () => Promise.resolve(),
    }));
    vi.doMock('@/modules/antigravity-runtime/switch/switchGuard', () => ({
      runWithSwitchGuard: async (_owner: string, fn: () => Promise<void>) => fn(),
    }));
    vi.doMock('@/modules/antigravity-runtime/switch/switchFlow', () => ({
      executeSwitchFlow: vi.fn(),
    }));
    vi.doMock('electron', () => ({ shell: { openExternal: vi.fn() } }));

    const { listCloudAccounts } = await import('@/modules/cloud-account/ipc/handler');
    const listedAccounts = await listCloudAccounts();

    expect(listedAccounts.find((account) => account.id === 'acc-1')?.is_active_classic).toBe(false);
    expect(listedAccounts.find((account) => account.id === 'acc-2')?.is_active_classic).toBe(true);
  });

  it('backfills missing oauth_client_key with active non-enterprise client', async () => {
    const updateTokenMock = vi.fn(async () => undefined);
    const setSettingMock = vi.fn();
    const accounts = [
      {
        id: 'acc-1',
        provider: 'google' as const,
        email: 'legacy@test.dev',
        token: {
          access_token: 'access',
          refresh_token: 'refresh',
          expires_in: 3600,
          expiry_timestamp: Math.floor(Date.now() / 1000) + 3600,
          token_type: 'Bearer',
          email: 'legacy@test.dev',
        },
        created_at: Math.floor(Date.now() / 1000),
        last_used: Math.floor(Date.now() / 1000),
      },
    ];

    vi.doMock('@/modules/cloud-account/persistence/cloudHandler', () => ({
      CloudAccountRepo: {
        getAccounts: vi.fn(async () => accounts),
        updateToken: updateTokenMock,
        shouldInjectTokenIntoCredentialStore: vi.fn(() => false),
        getActiveAccountIdForTarget: vi.fn(() => ''),
        getSetting: vi.fn((key: string, defaultValue: unknown) => {
          if (key === 'oauth_client_key_backfill_v1_done') {
            return false;
          }
          if (key === 'active_oauth_client_key') {
            return 'custom_a';
          }
          return defaultValue;
        }),
        setSetting: setSettingMock,
      },
    }));

    const setActiveOAuthClientKeyMock = vi.fn();
    const getActiveOAuthClientKeyMock = vi.fn(() => 'custom_a');
    vi.doMock('@/modules/cloud-account/services/GoogleAPIService', () => ({
      GoogleAPIService: {
        setActiveOAuthClientKey: setActiveOAuthClientKeyMock,
        getActiveOAuthClientKey: getActiveOAuthClientKeyMock,
      },
    }));

    vi.doMock('../../shared/logging/logger', () => ({
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      },
    }));
    vi.doMock('@/modules/app-shell/ipc/tray/handler', () => ({ updateTrayMenu: vi.fn() }));
    vi.doMock('@/modules/identity-profile/ipc/handler', () => ({
      ensureGlobalOriginalFromCurrentStorage: vi.fn(),
      generateDeviceProfile: vi.fn(),
      getStorageDirectoryPath: vi.fn(() => ''),
      isIdentityProfileApplyEnabled: vi.fn(() => false),
      loadGlobalOriginalProfile: vi.fn(),
      readCurrentDeviceProfile: vi.fn(),
      saveGlobalOriginalProfile: vi.fn(),
    }));
    vi.doMock('../../shared/platform/paths', () => ({
      getAntigravityDbPaths: () => [],
      refreshAntigravityProcessCache: () => Promise.resolve(),
    }));
    vi.doMock('@/modules/antigravity-runtime/switch/switchGuard', () => ({
      runWithSwitchGuard: async (_owner: string, fn: () => Promise<void>) => fn(),
    }));
    vi.doMock('@/modules/antigravity-runtime/switch/switchFlow', () => ({
      executeSwitchFlow: vi.fn(),
    }));
    vi.doMock('electron', () => ({ shell: { openExternal: vi.fn() } }));

    const { listCloudAccounts } = await import('@/modules/cloud-account/ipc/handler');
    await listCloudAccounts();

    expect(setActiveOAuthClientKeyMock).toHaveBeenCalledWith('custom_a');
    expect(updateTokenMock).toHaveBeenCalledWith(
      'acc-1',
      expect.objectContaining({
        oauth_client_key: 'custom_a',
      }),
    );
    expect(setSettingMock).toHaveBeenCalledWith('oauth_client_key_backfill_v1_done', true);
  });

  it('skips enterprise backfill for legacy account without project_id', async () => {
    const updateTokenMock = vi.fn(async () => undefined);
    const setSettingMock = vi.fn();
    const accounts = [
      {
        id: 'acc-legacy',
        provider: 'google' as const,
        email: 'legacy-enterprise@test.dev',
        token: {
          access_token: 'access',
          refresh_token: 'refresh',
          expires_in: 3600,
          expiry_timestamp: Math.floor(Date.now() / 1000) + 3600,
          token_type: 'Bearer',
          email: 'legacy-enterprise@test.dev',
        },
        created_at: Math.floor(Date.now() / 1000),
        last_used: Math.floor(Date.now() / 1000),
      },
    ];

    vi.doMock('@/modules/cloud-account/persistence/cloudHandler', () => ({
      CloudAccountRepo: {
        getAccounts: vi.fn(async () => accounts),
        updateToken: updateTokenMock,
        shouldInjectTokenIntoCredentialStore: vi.fn(() => false),
        getActiveAccountIdForTarget: vi.fn(() => ''),
        getSetting: vi.fn((key: string, defaultValue: unknown) => {
          if (key === 'oauth_client_key_backfill_v1_done') {
            return false;
          }
          if (key === 'active_oauth_client_key') {
            return 'antigravity_enterprise';
          }
          return defaultValue;
        }),
        setSetting: setSettingMock,
      },
    }));

    vi.doMock('@/modules/cloud-account/services/GoogleAPIService', () => ({
      GoogleAPIService: {
        setActiveOAuthClientKey: vi.fn(),
        getActiveOAuthClientKey: vi.fn(() => 'antigravity_enterprise'),
      },
    }));

    vi.doMock('../../shared/logging/logger', () => ({
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      },
    }));
    vi.doMock('@/modules/app-shell/ipc/tray/handler', () => ({ updateTrayMenu: vi.fn() }));
    vi.doMock('@/modules/identity-profile/ipc/handler', () => ({
      ensureGlobalOriginalFromCurrentStorage: vi.fn(),
      generateDeviceProfile: vi.fn(),
      getStorageDirectoryPath: vi.fn(() => ''),
      isIdentityProfileApplyEnabled: vi.fn(() => false),
      loadGlobalOriginalProfile: vi.fn(),
      readCurrentDeviceProfile: vi.fn(),
      saveGlobalOriginalProfile: vi.fn(),
    }));
    vi.doMock('../../shared/platform/paths', () => ({
      getAntigravityDbPaths: () => [],
      refreshAntigravityProcessCache: () => Promise.resolve(),
    }));
    vi.doMock('@/modules/antigravity-runtime/switch/switchGuard', () => ({
      runWithSwitchGuard: async (_owner: string, fn: () => Promise<void>) => fn(),
    }));
    vi.doMock('@/modules/antigravity-runtime/switch/switchFlow', () => ({
      executeSwitchFlow: vi.fn(),
    }));
    vi.doMock('electron', () => ({ shell: { openExternal: vi.fn() } }));

    const { listCloudAccounts } = await import('@/modules/cloud-account/ipc/handler');
    await listCloudAccounts();

    expect(updateTokenMock).not.toHaveBeenCalled();
    expect(setSettingMock).toHaveBeenCalledWith('oauth_client_key_backfill_v1_done', true);
  });
});
