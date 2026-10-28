import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceProfileRepo } from '@/modules/workspace/persistence/workspace-profile-repo';
import { createWorkspaceProfileService } from '@/modules/workspace/services/workspace-profile.service';
import type { WorkspaceLifecycleDelegate, WorkspaceProfile } from '@/modules/workspace/types';

const state = vi.hoisted(() => ({ base: '' }));
vi.mock('@/shared/platform/paths', () => ({ getProfilesBaseDir: () => state.base }));
vi.mock('@/modules/workspace/services/workspace-lifecycle.service', () => ({
  WorkspaceLifecycleService: {},
}));
vi.mock('@/modules/workspace/services/workspace-provisioning', () => ({
  reconcileAllWorkspaceProfiles: vi.fn(),
}));

describe('workspace profile deletion recovery', () => {
  let root: string;
  let profile: WorkspaceProfile;
  let record: WorkspaceProfile | null;
  let deleteRecord: ReturnType<typeof vi.fn<(id: string) => Promise<boolean>>>;
  let lifecycle: WorkspaceLifecycleDelegate;

  class FixtureProfileRepo extends WorkspaceProfileRepo {
    static override async getProfile() {
      return record;
    }
    static override async deleteProfile(id: string) {
      return deleteRecord(id);
    }
  }

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'agm-workspace-delete-'));
    state.base = path.join(root, 'profiles');
    profile = {
      id: 'aeb308ef-1b53-416d-890c-26564311b5c4',
      name: 'Workspace',
      accountId: 'account-a',
      projectPath: root,
      userDataDir: path.join(state.base, 'profile-a'),
      createdAt: 1,
    };
    record = profile;
    fs.mkdirSync(profile.userDataDir, { recursive: true });
    fs.writeFileSync(path.join(profile.userDataDir, 'history.txt'), 'saved history');
    deleteRecord = vi.fn(async () => {
      record = null;
      return true;
    });
    lifecycle = {
      launch: vi.fn(),
      stop: vi.fn(),
      getStatus: vi.fn(),
      withStoppedProfile: vi.fn(
        async (_id: string, _options: { force: boolean }, action: () => Promise<void>) => action(),
      ),
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const service = (delegate: WorkspaceLifecycleDelegate | undefined = lifecycle) =>
    createWorkspaceProfileService({
      profileRepo: FixtureProfileRepo,
      cloudAccountRepo: { getAccounts: async () => [], getAccount: async () => null },
      lifecycleDelegate: delegate,
    });

  it('requires process ownership before deleting persisted state', async () => {
    const ownerless = createWorkspaceProfileService({
      profileRepo: FixtureProfileRepo,
      cloudAccountRepo: { getAccounts: async () => [], getAccount: async () => null },
    });
    await expect(ownerless.delete(profile.id)).rejects.toThrow('process ownership is unavailable');
    expect(record).toEqual(profile);
    expect(fs.readFileSync(path.join(profile.userDataDir, 'history.txt'), 'utf8')).toBe(
      'saved history',
    );
  });

  it.each(['observation unavailable', 'exit unconfirmed'])(
    '%s leaves data and metadata intact',
    async (message) => {
      const failure = new Error(message);
      vi.mocked(lifecycle.withStoppedProfile).mockRejectedValueOnce(failure);

      await expect(service().delete(profile.id, { force: true })).rejects.toBe(failure);

      expect(lifecycle.withStoppedProfile).toHaveBeenCalledExactlyOnceWith(
        profile.id,
        { force: true },
        expect.any(Function),
      );
      expect(lifecycle.getStatus).not.toHaveBeenCalled();
      expect(deleteRecord).not.toHaveBeenCalled();
      expect(fs.readFileSync(path.join(profile.userDataDir, 'history.txt'), 'utf8')).toBe(
        'saved history',
      );
    },
  );

  it('rejects an outside directory before deleting its metadata', async () => {
    profile.userDataDir = path.join(root, 'outside');
    fs.mkdirSync(profile.userDataDir);
    fs.writeFileSync(path.join(profile.userDataDir, 'keep.txt'), 'outside data');

    await expect(service().delete(profile.id)).rejects.toMatchObject({
      code: 'DIRECTORY_REMOVAL_FAILED',
    });

    expect(deleteRecord).not.toHaveBeenCalled();
    expect(fs.readFileSync(path.join(profile.userDataDir, 'keep.txt'), 'utf8')).toBe(
      'outside data',
    );
  });

  it('rejects an owned directory whose parent junction resolves outside the profile root', async () => {
    const outside = path.join(root, 'outside');
    fs.mkdirSync(path.join(outside, 'nested'), { recursive: true });
    fs.writeFileSync(path.join(outside, 'nested/keep.txt'), 'outside data');
    const link = path.join(state.base, 'linked');
    fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    profile.userDataDir = path.join(link, 'nested');

    await expect(service().delete(profile.id)).rejects.toMatchObject({
      code: 'DIRECTORY_REMOVAL_FAILED',
    });

    expect(deleteRecord).not.toHaveBeenCalled();
    expect(fs.readFileSync(path.join(outside, 'nested/keep.txt'), 'utf8')).toBe('outside data');
  });

  it('keeps the record and reports the original partial cleanup failure', async () => {
    const failure = new Error('fixture cleanup denied');
    vi.spyOn(fs, 'rmSync').mockImplementationOnce(() => {
      fs.unlinkSync(path.join(profile.userDataDir, 'history.txt'));
      throw failure;
    });

    await expect(service().delete(profile.id)).rejects.toMatchObject({
      code: 'DIRECTORY_REMOVAL_FAILED',
      cause: failure,
    });

    expect(deleteRecord).not.toHaveBeenCalled();
    expect(record).toEqual(profile);
    expect(fs.existsSync(profile.userDataDir)).toBe(true);
    expect(fs.existsSync(path.join(profile.userDataDir, 'history.txt'))).toBe(false);
  });

  it('does not treat inaccessible profile state as an absent directory', async () => {
    const failure = Object.assign(new Error('fixture access denied'), { code: 'EACCES' });
    vi.spyOn(fs, 'lstatSync').mockImplementationOnce(() => {
      throw failure;
    });

    await expect(service().delete(profile.id)).rejects.toMatchObject({
      code: 'DIRECTORY_REMOVAL_FAILED',
      cause: failure,
    });

    expect(record).toEqual(profile);
    expect(deleteRecord).not.toHaveBeenCalled();
    expect(fs.readFileSync(path.join(profile.userDataDir, 'history.txt'), 'utf8')).toBe(
      'saved history',
    );
  });

  it('removes only the owned directory before completing metadata deletion', async () => {
    deleteRecord.mockImplementationOnce(async () => {
      expect(fs.existsSync(profile.userDataDir)).toBe(false);
      record = null;
      return true;
    });

    await expect(service().delete(profile.id)).resolves.toBeUndefined();

    expect(record).toBeNull();
    expect(deleteRecord).toHaveBeenCalledExactlyOnceWith(profile.id);
    expect(lifecycle.withStoppedProfile).toHaveBeenCalledExactlyOnceWith(
      profile.id,
      { force: false },
      expect.any(Function),
    );
  });

  it('preserves requested profile files while deleting metadata under the stopped lease', async () => {
    await service().delete(profile.id, { cleanUserDataDir: false });

    expect(record).toBeNull();
    expect(fs.readFileSync(path.join(profile.userDataDir, 'history.txt'), 'utf8')).toBe(
      'saved history',
    );
    expect(lifecycle.withStoppedProfile).toHaveBeenCalledOnce();
  });

  it('reports metadata failure after cleanup instead of claiming complete deletion', async () => {
    const failure = new Error('fixture metadata delete failed');
    deleteRecord.mockRejectedValueOnce(failure);

    await expect(service().delete(profile.id)).rejects.toBe(failure);

    expect(record).toEqual(profile);
    expect(fs.existsSync(profile.userDataDir)).toBe(false);
  });
});
