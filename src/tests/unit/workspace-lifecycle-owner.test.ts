import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LaunchContext } from '@/modules/antigravity-runtime/types';
import type { WorkspaceProfile } from '@/modules/workspace/types';
import { reserveSwitch } from '@/modules/antigravity-runtime/operation';
import { createWorkspaceLifecycleService } from '@/modules/workspace/services/workspace-lifecycle.service';

const state = vi.hoisted(() => ({
  prepare: vi.fn(),
  prepareWrite: vi.fn(),
  write: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
  share: vi.fn(),
  account: vi.fn(),
}));

vi.mock('@/modules/antigravity-runtime/launchContext', () => ({
  canonicalPath: (value: string) => path.resolve(value).toLowerCase(),
}));
vi.mock('@/modules/antigravity-runtime', async () => ({
  canonicalPath: (value: string) => path.resolve(value).toLowerCase(),
  getProcessUserDataDir: vi.fn(),
  observeProcesses: vi.fn(),
  buildAntigravityCredentialPayload: () => '{}',
  prepareClientAccountWrite: state.prepareWrite,
  prepareLaunchContext: state.prepare,
  runProcessOperation: (await import('@/modules/antigravity-runtime/operation'))
    .runProcessOperation,
  startFromContext: state.start,
  stopFromContext: state.stop,
}));
vi.mock('@/shared/platform/paths', () => ({ getAntigravityExtensionsDir: () => '/extensions' }));
vi.mock('@/modules/workspace/persistence/workspace-profile-repo', () => ({
  WorkspaceProfileRepo: {},
}));
vi.mock('@/modules/workspace/services/workspace-profile.service', () => ({
  defaultCloudAccountRepo: {},
}));
vi.mock('@/modules/workspace/services/workspace-provisioning', () => ({
  provisionWorkspaceProfileSharing: state.share,
}));

describe('workspace lifecycle ownership', () => {
  let root: string;
  let profile: WorkspaceProfile;
  let context: LaunchContext;
  let release: (() => void) | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'agm-workspace-owner-'));
    profile = {
      id: 'profile-a',
      name: 'Workspace A',
      accountId: 'account-a',
      projectPath: root,
      userDataDir: path.join(root, 'profile'),
      createdAt: 1,
    };
    context = {
      target: 'ide',
      executablePath: path.join(root, 'ide.exe'),
      args: [],
      defaultUserDataDir: path.join(root, 'default'),
      processes: [],
      pathOptions: { userDataDir: profile.userDataDir, executablePath: path.join(root, 'ide.exe') },
    };
    state.prepare.mockResolvedValue(context);
    state.prepareWrite.mockResolvedValue({ storage: 'sqlite', write: state.write });
    state.write.mockResolvedValue(undefined);
    state.start.mockResolvedValue({ pid: 100 });
    state.account.mockResolvedValue({ email: 'a@example.invalid', token: {} });
    vi.spyOn(fs, 'symlinkSync').mockImplementation(() => {
      throw new Error('fixture link disabled');
    });
  });
  afterEach(() => {
    release?.();
    release = undefined;
    vi.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const service = (profile: WorkspaceProfile) =>
    createWorkspaceLifecycleService({
      profileRepo: { getProfile: vi.fn(async () => profile) },
      cloudAccountRepo: { getAccount: state.account, getAccounts: vi.fn() },
    });

  it('rejects a busy primary switch before preparing or mutating a workspace', async () => {
    release = reserveSwitch('ide');
    await expect(service(profile).launch(profile.id)).rejects.toMatchObject({
      processDiagnostic: { reason: 'busy' },
    });
    expect(fs.existsSync(profile.userDataDir)).toBe(false);
    expect(state.prepare).not.toHaveBeenCalled();
    expect(state.write).not.toHaveBeenCalled();
    expect(state.account).not.toHaveBeenCalled();
  });

  it('does not interpret failed process observation as permission to write', async () => {
    state.prepare.mockRejectedValueOnce(new Error('observation unavailable'));
    await expect(service(profile).launch(profile.id)).rejects.toThrow('observation unavailable');
    expect(fs.existsSync(profile.userDataDir)).toBe(false);
    expect(state.write).not.toHaveBeenCalled();
    expect(state.start).not.toHaveBeenCalled();
  });

  it('returns the confirmed running instance without rewriting its credentials', async () => {
    state.prepare.mockResolvedValueOnce({ ...context, processes: [{ pid: 42 }] });
    await expect(service(profile).launch(profile.id)).resolves.toEqual({ pid: 42 });
    expect(state.write).not.toHaveBeenCalled();
    expect(state.start).not.toHaveBeenCalled();
  });

  it('holds ownership through writes and launch and coalesces concurrent starts', async () => {
    const lifecycle = service(profile);
    let finishWrite!: () => void;
    const writeStarted = Promise.withResolvers<void>();
    state.write.mockImplementationOnce(() => {
      writeStarted.resolve();
      return new Promise<void>((resolve) => {
        finishWrite = resolve;
      });
    });
    const first = lifecycle.launch(profile.id);
    await writeStarted.promise;
    expect(() => reserveSwitch('ide')).toThrow();
    const second = lifecycle.launch(profile.id);
    finishWrite();
    await expect(Promise.all([first, second])).resolves.toEqual([{ pid: 100 }, { pid: 100 }]);
    expect(state.write).toHaveBeenCalledTimes(1);
    expect(state.start).toHaveBeenCalledExactlyOnceWith(context);
    expect(state.prepareWrite).toHaveBeenCalledExactlyOnceWith(
      { email: 'a@example.invalid', name: 'a@example.invalid', token: {} },
      'ide',
      context.pathOptions,
    );
    release = reserveSwitch('ide');
  });

  it('reports stop observation failures instead of confirming an unobserved exit', async () => {
    state.prepare.mockRejectedValueOnce(new Error('observation unavailable'));
    await expect(service(profile).stop(profile.id)).rejects.toThrow('observation unavailable');
    expect(state.stop).not.toHaveBeenCalled();
    release = reserveSwitch('ide');
  });

  it('does not recreate a profile removed before launch acquired ownership', async () => {
    const getProfile = vi.fn().mockResolvedValueOnce(profile).mockResolvedValueOnce(null);
    const lifecycle = createWorkspaceLifecycleService({ profileRepo: { getProfile } });
    await expect(lifecycle.launch(profile.id)).rejects.toMatchObject({
      name: 'WorkspaceNotFoundError',
    });
    expect(state.prepare).not.toHaveBeenCalled();
    expect(state.write).not.toHaveBeenCalled();
  });

  it('rejects destructive work on a running profile without stopping it implicitly', async () => {
    state.prepare.mockResolvedValueOnce({ ...context, processes: [{ pid: 42 }] });
    const action = vi.fn();
    await expect(
      service(profile).withStoppedProfile(profile.id, { force: false }, action),
    ).rejects.toMatchObject({ name: 'ActiveWorkspaceDeletionError' });
    expect(state.stop).not.toHaveBeenCalled();
    expect(action).not.toHaveBeenCalled();
  });

  it('keeps destructive work blocked after an unconfirmed close', async () => {
    state.prepare.mockResolvedValueOnce({ ...context, processes: [{ pid: 42 }] });
    state.stop.mockRejectedValueOnce(new Error('exit unconfirmed'));
    const action = vi.fn();
    await expect(
      service(profile).withStoppedProfile(profile.id, { force: true }, action),
    ).rejects.toThrow('exit unconfirmed');
    expect(action).not.toHaveBeenCalled();
    release = reserveSwitch('ide');
  });

  it('retains the profile lease until destructive work completes', async () => {
    const lifecycle = service(profile);
    const started = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const deleting = lifecycle.withStoppedProfile(profile.id, { force: false }, async () => {
      started.resolve();
      await finish.promise;
    });
    await started.promise;
    await expect(lifecycle.launch(profile.id)).rejects.toMatchObject({
      processDiagnostic: { reason: 'busy' },
    });
    expect(state.write).not.toHaveBeenCalled();
    finish.resolve();
    await deleting;
    release = reserveSwitch('ide');
  });
});
