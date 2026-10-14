import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import type { SQL } from 'drizzle-orm';

const installation = z
  .object({
    ok: z.literal(true),
    commands: z.array(z.object({ executable: z.string(), args: z.array(z.string()) })),
    files: z.object({ accounts: z.string(), cli: z.string(), oauth: z.string() }),
  })
  .parse(
    JSON.parse(
      await readFile(`${process.cwd()}/src/tests/fixtures/macos-credential-install.json`, 'utf8'),
    ),
  );
const sqlitePayloads = z
  .object({
    oauth: z.string(),
    oauthTopic: z.string(),
    project: z.string(),
    projectTopic: z.string(),
    userStatus: z.string(),
    userStatusTopic: z.string(),
  })
  .parse(
    JSON.parse(
      await readFile(`${process.cwd()}/src/tests/fixtures/macos-client-protobuf.json`, 'utf8'),
    ),
  );

const state = vi.hoisted(() => ({
  files: new Map<string, string>(),
  rows: new Map<string, string>(),
  effects: [] as string[],
  commands: [] as { executable: string; args: string[] }[],
  keychain: '',
  version: '2.23.0',
  addStatus: 0,
  deleteStatus: 0,
  findStatus: 0,
  findSpawnError: false,
  failFiles: [] as string[],
  failSqlKey: '',
  failBackup: false,
  warnings: vi.fn(),
}));
const home = '/fixture/home';
const database = '/fixture/state.vscdb';
const cliFile = `${home}/.gemini/antigravity-cli/antigravity-oauth-token`;
const oauthFile = `${home}/.gemini/oauth_creds.json`;
const accountsFile = `${home}/.gemini/google_accounts.json`;

vi.mock('node:os', () => ({ default: { homedir: () => '/fixture/home' } }));
vi.mock('node:path', async (original) => {
  const actual = await original<typeof import('node:path')>();
  return { ...actual, default: actual.posix };
});
vi.mock('node:fs', () => ({
  default: {
    existsSync: (file: string) => state.files.has(file),
    readFileSync: (file: string) => {
      const value = state.files.get(file);
      if (value === undefined) {
        throw new Error('Missing fixture file');
      }
      return value;
    },
    mkdirSync: vi.fn(),
    writeFileSync: (file: string, value: string) => {
      state.effects.push(`write:${file}`);
      if (state.failFiles.includes(file)) {
        throw new Error('Fixture file write failed');
      }
      state.files.set(file, value);
    },
    chmodSync: (file: string, mode: number) => state.effects.push(`chmod:${file}:${mode}`),
    copyFileSync: (source: string, target: string) => {
      state.effects.push(`backup:${target}`);
      if (state.failBackup) {
        throw new Error('Fixture backup failed');
      }
      state.files.set(target, state.files.get(source) ?? '');
    },
  },
}));
vi.mock('child_process', () => {
  const mock = {
    execFileSync: vi.fn(() => {
      throw new Error('Unexpected synchronous exec in macOS chain');
    }),
    spawnSync: (executable: string, args: string[]) => {
      state.commands.push({ executable, args });
      state.effects.push(`command:${args[0]}`);
      if (executable !== 'security') {
        throw new Error('Unexpected command executable');
      }
      if (args[0] === 'delete-generic-password') {
        if (state.deleteStatus === 0) {
          state.keychain = '';
        }
        return { status: state.deleteStatus, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
      }
      if (args[0] === 'add-generic-password') {
        if (state.addStatus === 0) {
          state.keychain = args[args.indexOf('-w') + 1];
        }
        return {
          status: state.addStatus,
          stdout: Buffer.alloc(0),
          stderr: Buffer.from('Fixture write refused'),
        };
      }
      return {
        status: state.findStatus,
        stdout: Buffer.from(state.keychain),
        stderr: Buffer.alloc(0),
        ...(state.findSpawnError ? { error: new Error('Fixture spawn failed') } : {}),
      };
    },
  };
  return { ...mock, default: mock };
});
vi.mock('@/shared/logging/logger', () => ({ logger: { warn: state.warnings, info: vi.fn() } }));
vi.mock('@/shared/platform/paths', () => ({
  getAntigravityDbPaths: () => ['/fixture/state.vscdb'],
}));
vi.mock('@/modules/antigravity-runtime/utils/antigravityVersion', () => ({
  getAntigravityVersion: async () => ({
    shortVersion: state.version,
    bundleVersion: state.version,
  }),
  isCredentialStoreVersion: (version: { shortVersion: string }) =>
    Number(version.shortVersion.split('.')[0]) >= 2,
}));
vi.mock('@/shared/persistence/database/dbConnection', async () => {
  const { SQLiteSyncDialect } = await import('drizzle-orm/sqlite-core');
  const keyFrom = (condition: SQL) =>
    z.tuple([z.string()]).parse(new SQLiteSyncDialect().sqlToQuery(condition).params)[0];
  const applyRow = (key: string, value?: string) => {
    state.effects.push(`sqlite:${key}`);
    if (key === state.failSqlKey) {
      throw new Error('Fixture SQL write failed');
    }
    if (value === undefined) {
      state.rows.delete(key);
    } else {
      state.rows.set(key, value);
    }
  };
  return {
    openDrizzleConnection: (_file: string, _options: object, tuning: { busyTimeoutMs: number }) => {
      state.effects.push(`sqlite-open:${tuning.busyTimeoutMs}`);
      return {
        raw: {
          close: () => state.effects.push('sqlite-close'),
        },
        orm: {
          select: () => ({
            from: () => ({
              where: (condition: SQL) => ({
                get: () => {
                  const key = keyFrom(condition);
                  return state.rows.has(key) ? { value: state.rows.get(key) } : undefined;
                },
              }),
            }),
          }),
          insert: () => ({
            values: ({ key, value }: { key: string; value: string }) => ({
              onConflictDoUpdate: () => ({ run: () => applyRow(key, value) }),
            }),
          }),
          delete: () => ({
            where: (condition: SQL) => ({ run: () => applyRow(keyFrom(condition)) }),
          }),
        },
      };
    },
  };
});
vi.mock('@/modules/antigravity-runtime/credentials/windowsCredentialStore', () => ({
  readWindowsCredential: () => {
    throw new Error('Windows credentials are forbidden in this fixture');
  },
  writeWindowsCredential: () => {
    throw new Error('Windows credentials are forbidden in this fixture');
  },
}));
vi.mock('@napi-rs/keyring', () => ({
  Entry: class {
    constructor() {
      throw new Error('Native keyring is forbidden in this fixture');
    }
  },
}));
vi.mock('koffi', () => {
  throw new Error('Native APIs are forbidden in this fixture');
});
vi.mock('@/modules/antigravity-runtime/credentials/agyCliTokenStore', () => ({
  writeAgyCliToken: () => {
    throw new Error('Generic CLI file writer is forbidden in this fixture');
  },
}));
vi.mock('@/modules/antigravity-runtime/credentials/googleOAuthCredentialStore', () => ({
  writeGoogleOAuthCredentials: () => {
    throw new Error('Generic OAuth file writer is forbidden in this fixture');
  },
}));

import { prepareClientAccountWrite } from '@/modules/antigravity-runtime/credentials/clientAccountWrite';
import { readClientAccountToken } from '@/modules/antigravity-runtime/credentials/antigravityCredentialStore';
import { readMacOSCredentialStore } from '@/modules/antigravity-runtime/credentials/macosCredentialStore';

const originalPlatform = process.platform;
const credentials = {
  email: 'fixture@example.invalid',
  name: 'Fixture',
  token: {
    access_token: 'synthetic-access',
    refresh_token: 'synthetic-refresh',
    expiry_timestamp: 1_900_000_000,
    id_token: 'synthetic-id',
    project_id: 'synthetic-project',
  },
};
const expectedPayload = {
  token: {
    access_token: 'synthetic-access',
    token_type: 'Bearer',
    refresh_token: 'synthetic-refresh',
    expiry: '2030-03-17T17:46:40.000000Z',
  },
  auth_method: 'consumer',
  id_token: 'synthetic-id',
};

beforeEach(() => {
  Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' });
  state.files.clear();
  state.rows.clear();
  state.effects.length = 0;
  state.commands.length = 0;
  state.files.set(database, 'synthetic database');
  state.keychain = '';
  state.version = '2.23.0';
  state.addStatus = 0;
  state.deleteStatus = 0;
  state.findStatus = 0;
  state.findSpawnError = false;
  state.failFiles = [];
  state.failSqlKey = '';
  state.failBackup = false;
  state.warnings.mockClear();
});
afterEach(() =>
  Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform }),
);

describe('macOS account credential chain', () => {
  it('installs the complete payload and three caches in sequence without a classic readback', async () => {
    const prepared = await prepareClientAccountWrite(credentials, 'classic');
    expect(prepared.storage).toBe('credential-store');
    await prepared.write();
    const encoded = `go-keyring-base64:${Buffer.from(JSON.stringify(expectedPayload)).toString('base64')}`;
    expect(state.commands).toEqual([
      {
        executable: 'security',
        args: ['delete-generic-password', '-s', 'gemini', '-a', 'antigravity'],
      },
      {
        executable: 'security',
        args: ['add-generic-password', '-s', 'gemini', '-a', 'antigravity', '-w', encoded, '-A'],
      },
    ]);
    expect(state.effects).toEqual([
      'command:delete-generic-password',
      'command:add-generic-password',
      `write:${cliFile}`,
      `chmod:${cliFile}:384`,
      `write:${oauthFile}`,
      `chmod:${oauthFile}:384`,
      `write:${accountsFile}`,
      `chmod:${accountsFile}:384`,
    ]);
    expect(state.files.get(cliFile)).toBe(JSON.stringify(expectedPayload, null, 2));
    expect(state.files.get(oauthFile)).toBe(
      JSON.stringify(
        {
          access_token: 'synthetic-access',
          refresh_token: 'synthetic-refresh',
          token_type: 'Bearer',
          expiry_date: 1_900_000_000_000,
          id_token: 'synthetic-id',
          scope:
            'https://www.googleapis.com/auth/userinfo.email openid https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/userinfo.profile',
        },
        null,
        2,
      ),
    );
    expect(state.files.get(accountsFile)).toBe(
      JSON.stringify({ active: credentials.email, old: [] }, null, 2),
    );
    expect({
      ok: true,
      commands: state.commands,
      files: {
        cli: state.files.get(cliFile),
        oauth: state.files.get(oauthFile),
        accounts: state.files.get(accountsFile),
      },
    }).toEqual(installation);
  });

  it('preserves untrimmed fields, accepts millisecond expiry and keeps an empty root ID token', async () => {
    const input = {
      ...credentials,
      token: {
        ...credentials.token,
        access_token: ' synthetic-access ',
        expiry_timestamp: 1_900_000_000_123,
        id_token: '',
      },
    };
    await (await prepareClientAccountWrite(input, 'classic')).write();
    expect(state.files.get(cliFile)).toBe(
      JSON.stringify(
        {
          ...expectedPayload,
          token: { ...expectedPayload.token, access_token: ' synthetic-access ' },
          id_token: '',
        },
        null,
        2,
      ),
    );
    expect(JSON.parse(state.files.get(oauthFile)!)).toMatchObject({
      expiry_date: 1_900_000_000_123,
    });
  });

  it('writes a long password as one argument even when deleting the old item fails', async () => {
    state.deleteStatus = 44;
    const token = { ...credentials.token, access_token: `synthetic-${'a'.repeat(6000)}` };
    await (await prepareClientAccountWrite({ ...credentials, token }, 'classic')).write();
    expect(state.commands.map((call) => call.args[0])).toEqual([
      'delete-generic-password',
      'add-generic-password',
    ]);
    expect(state.keychain.length).toBeGreaterThan(6000);
    expect(
      JSON.parse(Buffer.from(state.keychain.slice(18), 'base64').toString('utf8')).token
        .access_token,
    ).toBe(token.access_token);
  });

  it.each([cliFile, oauthFile, accountsFile])(
    'keeps successful Keychain installation when cache write fails: %s',
    async (file) => {
      state.failFiles = [file];
      await expect(
        (await prepareClientAccountWrite(credentials, 'classic')).write(),
      ).resolves.toBeUndefined();
      expect(state.commands).toHaveLength(2);
      expect(state.files.has(file)).toBe(false);
      expect(state.files.has(accountsFile)).toBe(file !== oauthFile && file !== accountsFile);
    },
  );

  it('replaces a malformed account cache without preserving its previous account history', async () => {
    state.files.set(accountsFile, '{malformed');
    await (await prepareClientAccountWrite(credentials, 'classic')).write();
    expect(state.files.get(accountsFile)).toBe(
      JSON.stringify({ active: credentials.email, old: [] }, null, 2),
    );
  });

  it('fails a native write without an existing database and does not mirror files', async () => {
    state.files.delete(database);
    state.addStatus = 1;
    await expect((await prepareClientAccountWrite(credentials, 'classic')).write()).rejects.toThrow(
      'macOS security command failed',
    );
    expect(state.effects).toEqual([
      'command:delete-generic-password',
      'command:add-generic-password',
    ]);
  });

  it('falls back to the existing database and ignores backup and injection failures', async () => {
    state.addStatus = 1;
    state.failBackup = true;
    state.failSqlKey = 'antigravityUnifiedStateSync.userStatus';
    await expect(
      (await prepareClientAccountWrite(credentials, 'classic')).write(),
    ).resolves.toBeUndefined();
    expect(state.effects).toEqual([
      'command:delete-generic-password',
      'command:add-generic-password',
      `backup:${database}.backup`,
      'sqlite-open:2000',
      'sqlite:antigravityUnifiedStateSync.oauthToken',
      'sqlite:antigravityUnifiedStateSync.userStatus',
      'sqlite-close',
    ]);
    expect(state.rows.has('antigravityUnifiedStateSync.oauthToken')).toBe(true);
    expect(state.files.has(cliFile)).toBe(false);
  });

  it.each(['classic', 'ide'] as const)(
    'uses sequential ORM writes for %s legacy storage',
    async (target) => {
      state.version = '1.107.0';
      state.rows.set('workspace.keep', 'keep');
      state.rows.set('google.antigravity', 'keep-cache');
      state.rows.set('antigravityAuthStatus', 'keep-auth-status');
      state.rows.set('jetskiStateSync.agentManagerInitState', 'old');
      state.rows.set('antigravityUnifiedStateSync.oauthToken', '!invalid-base64!');
      const prepared = await prepareClientAccountWrite(credentials, target);
      expect(prepared.storage).toBe('sqlite');
      await prepared.write();
      expect(state.commands).toEqual([]);
      expect(state.rows).toEqual(
        new Map([
          ['workspace.keep', 'keep'],
          ['google.antigravity', 'keep-cache'],
          ['antigravityAuthStatus', 'keep-auth-status'],
          ['antigravityUnifiedStateSync.oauthToken', sqlitePayloads.oauthTopic],
          ['antigravityUnifiedStateSync.userStatus', sqlitePayloads.userStatusTopic],
          ['antigravityUnifiedStateSync.enterprisePreferences', sqlitePayloads.projectTopic],
          ['antigravityOnboarding', 'true'],
        ]),
      );
    },
  );

  it('propagates direct SQLite failure with earlier statements retained', async () => {
    state.version = '1.0.0';
    state.failSqlKey = 'antigravityUnifiedStateSync.userStatus';
    await expect((await prepareClientAccountWrite(credentials, 'classic')).write()).rejects.toThrow(
      'Fixture SQL write failed',
    );
    expect(state.rows.has('antigravityUnifiedStateSync.oauthToken')).toBe(true);
  });

  it('attempts service-machine synchronization even when the native-write database fallback fails', async () => {
    state.addStatus = 1;
    state.failSqlKey = 'antigravityUnifiedStateSync.userStatus';
    const prepared = await prepareClientAccountWrite(
      { ...credentials, serviceMachineId: 'synthetic-machine' },
      'classic',
    );
    await expect(prepared.write()).resolves.toBeUndefined();
    expect(state.rows.get('telemetry.serviceMachineId')).toBe('synthetic-machine');
  });

  it('confirms agy using only the system refresh token after installing all caches', async () => {
    await (await prepareClientAccountWrite(credentials, 'agy')).write();
    expect(state.commands.map((call) => call.args[0])).toEqual([
      'delete-generic-password',
      'add-generic-password',
      'find-generic-password',
    ]);
    expect(state.files.has(cliFile)).toBe(true);
  });

  it('does not allow a CLI cache to confirm an agy switch when Keychain lookup fails', async () => {
    state.findStatus = 44;
    await expect((await prepareClientAccountWrite(credentials, 'agy')).write()).rejects.toThrow(
      'No credential found in macOS Keychain',
    );
    expect(state.files.has(cliFile)).toBe(true);
  });

  it('reads only the refresh token and prefers the CLI cache after a failed system lookup', async () => {
    state.keychain = `go-keyring-base64:${Buffer.from(JSON.stringify(expectedPayload)).toString('base64')}`;
    expect(readMacOSCredentialStore(true)).toEqual({ refreshToken: 'synthetic-refresh' });
    state.findStatus = 44;
    state.files.set(cliFile, JSON.stringify({ token: { refresh_token: 'synthetic-cli' } }));
    state.files.set(oauthFile, JSON.stringify({ refresh_token: 'synthetic-oauth' }));
    expect(await readClientAccountToken('agy')).toEqual({ refreshToken: 'synthetic-cli' });
    state.files.set(cliFile, '{invalid');
    expect(readMacOSCredentialStore(true)).toEqual({ refreshToken: 'synthetic-oauth' });
  });

  it('does not fall back to files for spawn errors or malformed successful Keychain output', () => {
    state.files.set(cliFile, JSON.stringify({ refresh_token: 'synthetic-cache' }));
    state.findSpawnError = true;
    expect(() => readMacOSCredentialStore(true)).toThrow('Failed to execute security command');
    state.findSpawnError = false;
    state.keychain = 'go-keyring-base64:!invalid!';
    expect(() => readMacOSCredentialStore(true)).toThrow('Base64 decode failed');
  });
});
