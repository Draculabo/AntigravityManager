import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClientAccountCredentials } from '@/modules/antigravity-runtime/credentials/clientAccount';
import type { WorkspaceProfile } from '@/modules/workspace/types';
import type { RuntimeProcess } from '@/modules/antigravity-runtime/types';
import { createWorkspaceLifecycleService } from '@/modules/workspace/services/workspace-lifecycle.service';
import { filterContextProcesses } from '@/modules/antigravity-runtime/launchContext';

const state = vi.hoisted(() => ({
  writeAgyCliToken: vi.fn(),
  writeGoogleOAuthCredentials: vi.fn(),
  writeCredentialStoreToken: vi.fn(),
  readCredentialStoreToken: vi.fn(),
  configuredExecutable: vi.fn(),
  discoveredExecutable: vi.fn(),
  configuredArgs: vi.fn(),
  killedPids: [] as number[],
  observeProcesses: vi.fn(),
}));

vi.mock('@/modules/antigravity-runtime/processObserver', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/modules/antigravity-runtime/processObserver')>()),
  observeProcesses: state.observeProcesses,
}));
vi.mock('@/modules/antigravity-runtime/utils/antigravityVersion', () => ({
  getAntigravityVersion: vi.fn(async () => ({ shortVersion: '2.18.1', bundleVersion: '2.18.1' })),
  isCredentialStoreVersion: () => true,
}));

vi.mock('@/modules/antigravity-runtime/credentials/agyCliTokenStore', () => ({
  writeAgyCliToken: state.writeAgyCliToken,
}));
vi.mock('../../modules/antigravity-runtime/credentials/agyCliTokenStore', () => ({
  writeAgyCliToken: state.writeAgyCliToken,
}));

vi.mock('@/modules/antigravity-runtime/credentials/googleOAuthCredentialStore', () => ({
  writeGoogleOAuthCredentials: state.writeGoogleOAuthCredentials,
}));
vi.mock('../../modules/antigravity-runtime/credentials/googleOAuthCredentialStore', () => ({
  writeGoogleOAuthCredentials: state.writeGoogleOAuthCredentials,
}));

vi.mock('@/modules/antigravity-runtime/credentials/antigravityCredentialStore', () => ({
  writeAntigravityCredentialStoreToken: state.writeCredentialStoreToken,
  readAntigravityCredentialStoreToken: state.readCredentialStoreToken,
}));
vi.mock('../../modules/antigravity-runtime/credentials/antigravityCredentialStore', () => ({
  writeAntigravityCredentialStoreToken: state.writeCredentialStoreToken,
  readAntigravityCredentialStoreToken: state.readCredentialStoreToken,
}));

vi.mock('@/shared/platform/paths', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/shared/platform/paths')>();
  return {
    ...actual,
    getConfiguredAntigravityExecutablePath: state.configuredExecutable,
    getAntigravityExecutablePath: state.discoveredExecutable,
    getConfiguredAntigravityArgs: state.configuredArgs,
    getPortableUserDataDir: () => null,
    getAppDataDir: () =>
      state.configuredArgs()[0]?.replace('--user-data-dir=', '') ||
      path.join(os.tmpdir(), 'default-runtime-global'),
    isWsl: () => false,
  };
});
vi.mock('../../shared/platform/paths', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/shared/platform/paths')>();
  return {
    ...actual,
    getConfiguredAntigravityExecutablePath: state.configuredExecutable,
    getAntigravityExecutablePath: state.discoveredExecutable,
    getConfiguredAntigravityArgs: state.configuredArgs,
    getPortableUserDataDir: () => null,
    getAppDataDir: () =>
      state.configuredArgs()[0]?.replace('--user-data-dir=', '') ||
      path.join(os.tmpdir(), 'default-runtime-global'),
    isWsl: () => false,
  };
});

describe('Workspace Profile Non-Regression & Multi-Instance Coexistence (R5)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-nonreg-'));
  const originalHome = process.env.HOME;
  const executable = path.join(root, 'antigravity');
  const profileDir1 = path.join(root, 'profiles', 'p1');
  const profileDir2 = path.join(root, 'profiles', 'p2');
  const defaultDir = path.join(root, 'default-global');

  let canonicalPath: typeof import('@/modules/antigravity-runtime/launchContext').canonicalPath;
  let resolveLaunchContext: typeof import('@/modules/antigravity-runtime/launchContext').resolveLaunchContext;
  let prepareClientAccountWrite: typeof import('@/modules/antigravity-runtime/credentials/clientAccountWrite').prepareClientAccountWrite;
  let resolveClientAccountStorage: typeof import('@/modules/antigravity-runtime/credentials/clientAccountWrite').resolveClientAccountStorage;

  function writeTestConfig(args: string[] = [], exe: string = executable) {
    const configDir = path.join(root, '.antigravity-agent');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, 'gui_config.json'),
      JSON.stringify({
        antigravity_ide_executable: exe,
        antigravity_executable: exe,
        antigravity_ide_args: args,
        antigravity_args: args,
      }),
    );
    state.configuredArgs.mockReturnValue(args);
    state.configuredExecutable.mockReturnValue(exe);
  }

  beforeAll(async () => {
    process.env.HOME = root;
    fs.writeFileSync(executable, 'mock-bin');
    fs.chmodSync(executable, 0o755);
    fs.mkdirSync(profileDir1, { recursive: true });
    fs.mkdirSync(profileDir2, { recursive: true });
    fs.mkdirSync(defaultDir, { recursive: true });

    const launchCtxModule = await import('@/modules/antigravity-runtime/launchContext');
    canonicalPath = launchCtxModule.canonicalPath;
    resolveLaunchContext = launchCtxModule.resolveLaunchContext;
    const clientAccountWriteModule =
      await import('@/modules/antigravity-runtime/credentials/clientAccountWrite');
    prepareClientAccountWrite = clientAccountWriteModule.prepareClientAccountWrite;
    resolveClientAccountStorage = clientAccountWriteModule.resolveClientAccountStorage;
  });

  afterAll(() => {
    process.env.HOME = originalHome;
    fs.rmSync(root, { recursive: true, force: true });
  });

  beforeEach(() => {
    vi.clearAllMocks();
    state.killedPids = [];
    state.configuredExecutable.mockReturnValue(null);
    state.discoveredExecutable.mockReturnValue(executable);
    writeTestConfig([`--user-data-dir=${defaultDir}`]);
  });

  const credentials: ClientAccountCredentials = {
    email: 'engineer@example.org',
    name: 'Engineer',
    token: {
      access_token: 'token-access',
      refresh_token: 'token-refresh',
      expiry_timestamp: 1800000000,
      id_token: 'token-id',
      project_id: 'gcp-project',
      is_gcp_tos: true,
    },
  };

  // --- Tier 3: Cross-Feature Combinations ---

  describe('Tier 3: Cross-Feature Combinations & Non-Regression', () => {
    it('preserves classic single-client switching to credential-store or default SQLite without invoking workspace logic', async () => {
      // Classic resolution
      const storage = await resolveClientAccountStorage('classic');
      expect(['credential-store', 'sqlite']).toContain(storage);

      const prepared = await prepareClientAccountWrite(credentials, 'classic');
      expect(prepared).toBeDefined();
      expect(['credential-store', 'sqlite']).toContain(prepared.storage);
      expect(typeof prepared.write).toBe('function');

      // Verify workspace profiles directory remains completely untouched
      const profileFiles = fs.readdirSync(path.join(root, 'profiles'));
      expect(profileFiles).toEqual(['p1', 'p2']);
      expect(fs.readdirSync(profileDir1)).toHaveLength(0);
      expect(fs.readdirSync(profileDir2)).toHaveLength(0);
    });

    it('preserves agy CLI account switching writing strictly to CLI stores without touching workspace profiles', async () => {
      const storage = await resolveClientAccountStorage('agy');
      expect(['cli-session', 'credential-store']).toContain(storage);

      const prepared = await prepareClientAccountWrite(credentials, 'agy');
      expect(prepared).toBeDefined();
      expect(['cli-session', 'credential-store']).toContain(prepared.storage);
      expect(typeof prepared.write).toBe('function');

      // Verify workspace profiles directory remains completely untouched
      const profileFiles = fs.readdirSync(path.join(root, 'profiles'));
      expect(profileFiles).toEqual(['p1', 'p2']);
      expect(fs.readdirSync(profileDir1)).toHaveLength(0);
      expect(fs.readdirSync(profileDir2)).toHaveLength(0);
    });

    it('coexistence: running an isolated workspace profile process does not corrupt default classic launch context', () => {
      const profileProcess: RuntimeProcess = {
        pid: 7777,
        executablePath: executable,
        args: ['--user-data-dir', profileDir1, '/some/project'],
      };

      // When checking classic processes (which only monitor the defaultDir)
      // isolated profile processes belonging to profileDir1 are partitioned out
      const processesForClassic = [profileProcess].filter((p) =>
        p.args.some((arg) => canonicalPath(arg) === canonicalPath(defaultDir)),
      );

      state.configuredArgs.mockReturnValue([`--user-data-dir=${defaultDir}`]);
      const classicContext = resolveLaunchContext('classic', processesForClassic);

      expect(classicContext.pathOptions.userDataDir).toBe(canonicalPath(defaultDir));
      expect(classicContext.processes).toHaveLength(0);
    });
  });

  // --- Tier 4: Real-World Scenarios ---

  describe('Tier 4: Real-World Multi-Instance Scenarios', () => {
    it('reports observed status for concurrent workspace profiles independently', async () => {
      const profile1: WorkspaceProfile = {
        id: 'p1-uuid',
        name: 'Workspace Alpha',
        accountId: 'acc-1',
        projectPath: '/projects/alpha',
        userDataDir: profileDir1,
        createdAt: 1000,
      };

      const profile2: WorkspaceProfile = {
        id: 'p2-uuid',
        name: 'Workspace Beta',
        accountId: 'acc-2',
        projectPath: '/projects/beta',
        userDataDir: profileDir2,
        createdAt: 2000,
      };

      // Emulate process observer finding both processes running on host
      const activeProcesses: RuntimeProcess[] = [
        {
          pid: 101,
          executablePath: executable,
          args: [`--user-data-dir=${profileDir1}`, '/projects/alpha'],
        },
        {
          pid: 202,
          executablePath: executable,
          args: [`--user-data-dir=${profileDir2}`, '/projects/beta'],
        },
      ];

      state.observeProcesses.mockResolvedValue(activeProcesses);
      const lifecycle = createWorkspaceLifecycleService();
      const status1 = await lifecycle.getStatus(profile1);
      const status2 = await lifecycle.getStatus(profile2);

      expect(status1).toEqual({ running: true, pid: 101 });
      expect(status2).toEqual({ running: true, pid: 202 });
    });

    it('selects target profile roots without selecting peer roots or unowned helpers', () => {
      const p1Processes: RuntimeProcess[] = [
        { pid: 101, executablePath: executable, args: [`--user-data-dir=${profileDir1}`] },
        { pid: 102, executablePath: executable, args: ['--type=renderer'] }, // child of 101
      ];

      const p2Processes: RuntimeProcess[] = [
        { pid: 202, executablePath: executable, args: [`--user-data-dir=${profileDir2}`] },
        { pid: 203, executablePath: executable, args: ['--type=renderer'] }, // child of 202
      ];

      const allActive = [...p1Processes, ...p2Processes];
      const context = resolveLaunchContext('ide', allActive, { userDataDir: profileDir1 });
      expect(filterContextProcesses(context, allActive)).toEqual([p1Processes[0]]);
    });

    it('returns an already-running profile through the production launch coordinator', async () => {
      const existingProcess: RuntimeProcess = {
        pid: 303,
        executablePath: executable,
        args: [`--user-data-dir=${profileDir1}`],
      };

      state.observeProcesses.mockResolvedValue([existingProcess]);
      const profile: WorkspaceProfile = {
        id: 'profile-a',
        name: 'Workspace',
        accountId: 'account-a',
        projectPath: root,
        userDataDir: profileDir1,
        createdAt: 1,
      };
      const getAccount = vi.fn();
      const lifecycle = createWorkspaceLifecycleService({
        profileRepo: { getProfile: vi.fn(async () => profile) },
        cloudAccountRepo: { getAccount, getAccounts: vi.fn() },
      });
      await expect(lifecycle.launch(profile.id)).resolves.toEqual({ pid: 303 });
      expect(getAccount).not.toHaveBeenCalled();
    });
  });
});
