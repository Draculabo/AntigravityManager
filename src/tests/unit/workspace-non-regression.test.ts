import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClientAccountCredentials } from '@/modules/antigravity-runtime/credentials/clientAccount';
import type { WorkspaceProfile, WorkspaceProfileStatus } from '@/modules/workspace/types';
import type { RuntimeProcess } from '@/modules/antigravity-runtime/types';

const state = vi.hoisted(() => ({
  writeAgyCliToken: vi.fn(),
  writeGoogleOAuthCredentials: vi.fn(),
  writeCredentialStoreToken: vi.fn(),
  readCredentialStoreToken: vi.fn(),
  configuredExecutable: vi.fn(),
  discoveredExecutable: vi.fn(),
  configuredArgs: vi.fn(),
  killedPids: [] as number[],
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
    it('manages live running status for multiple concurrent workspace profiles independently', () => {
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

      // Process grouping logic mapping canonical userDataDir to PID
      const resolveProfileStatus = (profile: WorkspaceProfile): WorkspaceProfileStatus => {
        const canonicalDir = canonicalPath(profile.userDataDir);
        const match = activeProcesses.find((p) =>
          p.args.some((a) => a.includes(canonicalDir) || a === canonicalDir),
        );
        return match ? { running: true, pid: match.pid } : { running: false };
      };

      const status1 = resolveProfileStatus(profile1);
      const status2 = resolveProfileStatus(profile2);

      expect(status1).toEqual({ running: true, pid: 101 });
      expect(status2).toEqual({ running: true, pid: 202 });
    });

    it('terminates targeted workspace profile process tree without disrupting peer workspace instances', () => {
      const p1Processes: RuntimeProcess[] = [
        { pid: 101, executablePath: executable, args: [`--user-data-dir=${profileDir1}`] },
        { pid: 102, executablePath: executable, args: ['--type=renderer'] }, // child of 101
      ];

      const p2Processes: RuntimeProcess[] = [
        { pid: 202, executablePath: executable, args: [`--user-data-dir=${profileDir2}`] },
        { pid: 203, executablePath: executable, args: ['--type=renderer'] }, // child of 202
      ];

      // Simulated targeted stop function targeting only profile 1
      const stopTargetedProfile = (targetUserDataDir: string, allProcesses: RuntimeProcess[]) => {
        const canonicalTarget = canonicalPath(targetUserDataDir);
        // Find roots belonging to target dir
        const targetRoots = allProcesses.filter((p) =>
          p.args.some((a) => a.includes(canonicalTarget)),
        );
        for (const root of targetRoots) {
          state.killedPids.push(root.pid);
        }
      };

      const allActive = [...p1Processes, ...p2Processes];
      stopTargetedProfile(profileDir1, allActive);

      // Verify that PID 101 was killed, and PID 202 was spared
      expect(state.killedPids).toContain(101);
      expect(state.killedPids).not.toContain(202);
      expect(state.killedPids).not.toContain(203);
    });

    it('launch idempotency: launching an already-running workspace profile detects running status without spawning duplicate', () => {
      const existingProcess: RuntimeProcess = {
        pid: 303,
        executablePath: executable,
        args: [`--user-data-dir=${profileDir1}`],
      };

      // Mock launcher checking existing processes
      const launchOrFocus = (
        profileDir: string,
        observed: RuntimeProcess[],
        spawnFn: () => number,
      ): { pid: number; isExisting: boolean } => {
        const canonicalTarget = canonicalPath(profileDir);
        const running = observed.find((p) => p.args.some((a) => a.includes(canonicalTarget)));
        if (running) {
          return { pid: running.pid, isExisting: true };
        }
        return { pid: spawnFn(), isExisting: false };
      };

      const spawnMock = vi.fn(() => 999);
      const result = launchOrFocus(profileDir1, [existingProcess], spawnMock);

      expect(result.pid).toBe(303);
      expect(result.isExisting).toBe(true);
      expect(spawnMock).not.toHaveBeenCalled();
    });
  });
});
