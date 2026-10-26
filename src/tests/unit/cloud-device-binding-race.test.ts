import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CloudAccountRepo } from '@/modules/cloud-account/persistence/cloudHandler';
import { getCloudDb } from '@/modules/cloud-account/persistence/cloud-account-db';
import { CloudAccountDeviceBindingStore } from '@/modules/cloud-account/persistence/cloud-account-device-binding-store';
import {
  bindCloudIdentityProfile,
  bindCloudIdentityProfileWithPayload,
} from '@/modules/cloud-account/services/cloud-account-identity-profile.service';
import { switchCloudAccountCore } from '@/modules/cloud-account/services/cloud-account-switch.service';
import { prepareClientAccountWrite } from '@/modules/antigravity-runtime';
import {
  generateDeviceProfile,
  readCurrentDeviceProfile,
  saveGlobalOriginalProfile,
} from '@/modules/identity-profile/ipc/handler';
import type { DeviceProfile } from '@/modules/identity-profile/types';
import type { CloudAccount } from '@/modules/cloud-account/types';
import { createAccount } from './proxy-real-path.harness';

const state = vi.hoisted(() => ({ directory: '' }));
vi.mock('better-sqlite3', async () => {
  const { createRequire } = await import('node:module');
  return { default: createRequire(import.meta.url)('better-sqlite3') };
});
vi.mock('@/shared/platform/paths', () => ({
  getCloudAccountsDbPath: () => path.join(state.directory, 'accounts.db'),
}));
vi.mock('@/modules/identity-profile/ipc/handler', () => ({
  generateDeviceProfile: vi.fn(),
  readCurrentDeviceProfile: vi.fn(),
  ensureGlobalOriginalFromCurrentStorage: vi.fn(),
  saveGlobalOriginalProfile: vi.fn(),
  loadGlobalOriginalProfile: vi.fn(),
  isIdentityProfileApplyEnabled: () => false,
}));
vi.mock('@/modules/antigravity-runtime', () => ({
  prepareLaunchContext: vi.fn(),
  prepareClientAccountWrite: vi.fn(async () => ({ storage: 'credential-store', write: vi.fn() })),
}));
vi.mock('@/modules/antigravity-runtime/switch/switchGuard', () => ({
  runWithSwitchGuard: async (_scope: string, work: () => Promise<void>) => work(),
}));
vi.mock('@/modules/antigravity-runtime/switch/switchFlow', () => ({
  executeSwitchFlow: vi.fn(async () => {}),
}));

function profile(key: string): DeviceProfile {
  return {
    machineId: key,
    macMachineId: `${key}-mac`,
    devDeviceId: `${key}-dev`,
    sqmId: `{${key}}`,
  };
}
function observe<T>(promise: Promise<T>) {
  return promise.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
}
async function seed() {
  const account = createAccount('profile-race');
  account.token.refresh_token = '';
  return CloudAccountRepo.insertAccount(account);
}
type Change = 'recreate' | 'token' | 'binding' | 'history';
// Repository writes execute synchronously before returning their promises. Retain and drain
// those promises when injecting a competing commit into the synchronous generation boundary.
function compete(account: CloudAccount, change: Change): Promise<void>[] {
  const work: Promise<void>[] = [];
  if (change === 'recreate') {
    work.push(CloudAccountRepo.removeAccount(account.id));
  }
  const updated = structuredClone(account);
  if (change === 'token') {
    updated.token.session_id = 'new-session';
  } else if (change === 'binding') {
    updated.device_profile = profile('winner');
    updated.device_history = [
      {
        id: 'winner',
        createdAt: 1,
        label: 'generated',
        profile: profile('winner'),
        isCurrent: true,
      },
    ];
  } else if (change === 'history') {
    updated.device_history = [
      {
        id: 'new-history',
        createdAt: 1,
        label: 'generated',
        profile: profile('history'),
        isCurrent: true,
      },
    ];
  }
  work.push(CloudAccountRepo.addAccount(updated));
  return work;
}

beforeEach(() => {
  state.directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agm-binding-race-'));
  vi.mocked(generateDeviceProfile).mockReturnValue(profile('candidate'));
  vi.mocked(readCurrentDeviceProfile).mockReturnValue(profile('captured'));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  fs.rmSync(state.directory, { recursive: true, force: true });
});

describe('device binding ownership with native SQLite', () => {
  for (const mode of ['capture', 'generate', 'payload'] as const) {
    it.each(['recreate', 'token', 'binding', 'history'] as const)(
      `rejects a stale ${mode} binding after %s`,
      async (change) => {
        const account = await seed();
        const entered = Promise.withResolvers<void>();
        const resume = Promise.withResolvers<void>();
        const getAccount = CloudAccountRepo.getAccount.bind(CloudAccountRepo);
        vi.spyOn(CloudAccountRepo, 'getAccount').mockImplementationOnce(async (id) => {
          const snapshot = await getAccount(id);
          entered.resolve();
          await resume.promise;
          return snapshot;
        });
        const pending = observe(
          mode === 'payload'
            ? bindCloudIdentityProfileWithPayload(account.id, profile('payload'))
            : bindCloudIdentityProfile(account.id, mode),
        );
        try {
          await entered.promise;
          await Promise.all(compete(account, change));
          const expected = await getAccount(account.id);
          resume.resolve();
          expect(await pending).toMatchObject({
            error: {
              name: 'CloudIdentityProfileError',
              profileCode: 'profile-write-failed',
              cause: { name: 'CloudAccountRefreshContextChangedError' },
            },
          });
          expect(await getAccount(account.id)).toEqual(expected);
          expect(saveGlobalOriginalProfile).not.toHaveBeenCalled();
        } finally {
          resume.resolve();
          await pending;
        }
      },
    );
  }

  it.each(['recreate', 'token', 'binding', 'history'] as const)(
    'stops automatic first binding after %s inside generation',
    async (change) => {
      const account = await seed();
      let work: Promise<void>[] = [];
      let expected: Promise<CloudAccount | undefined> | undefined;
      vi.mocked(generateDeviceProfile).mockImplementationOnce(() => {
        work = compete(account, change);
        expected = CloudAccountRepo.getAccount(account.id);
        return profile('obsolete');
      });
      try {
        const outcome = await observe(switchCloudAccountCore(account.id, 'agy'));
        expect(outcome).toMatchObject({
          error: { name: 'CloudAccountSwitchError', diagnostic: { stage: 'identity-preparation' } },
        });
        expect(await CloudAccountRepo.getAccount(account.id)).toEqual(await expected);
        expect(saveGlobalOriginalProfile).not.toHaveBeenCalled();
        expect(prepareClientAccountWrite).not.toHaveBeenCalled();
      } finally {
        await Promise.all(work);
      }
    },
  );

  it('guards the final binding write after the caller already selected a profile', async () => {
    const account = await seed();
    const original = CloudAccountDeviceBindingStore.setDeviceBinding.bind(
      CloudAccountDeviceBindingStore,
    );
    let work: Promise<void>[] = [];
    let expected: Promise<CloudAccount | undefined> | undefined;
    vi.spyOn(CloudAccountDeviceBindingStore, 'setDeviceBinding').mockImplementationOnce(
      (...args) => {
        work = compete(account, 'binding');
        expected = CloudAccountRepo.getAccount(account.id);
        original(...args);
      },
    );
    try {
      expect(await observe(bindCloudIdentityProfile(account.id, 'generate'))).toMatchObject({
        error: { profileCode: 'profile-write-failed' },
      });
      expect(await CloudAccountRepo.getAccount(account.id)).toEqual(await expected);
      expect(saveGlobalOriginalProfile).not.toHaveBeenCalled();
    } finally {
      await Promise.all(work);
    }
  });

  it('keeps profile/history atomic and preserves the storage failure cause', async () => {
    const account = await seed();
    const { raw } = getCloudDb();
    try {
      raw.exec(
        "CREATE TRIGGER deny_binding AFTER UPDATE OF device_profile_json ON accounts BEGIN SELECT RAISE(ABORT, 'synthetic binding failure'); END",
      );
    } finally {
      raw.close();
    }
    expect(await observe(bindCloudIdentityProfile(account.id, 'generate'))).toMatchObject({
      error: {
        profileCode: 'profile-write-failed',
        cause: { message: 'synthetic binding failure' },
      },
    });
    expect(await CloudAccountRepo.getAccount(account.id)).toEqual(account);
    expect(saveGlobalOriginalProfile).not.toHaveBeenCalled();
  });

  it('keeps the first accepted manual binding and rejects the waiting old binding', async () => {
    const account = await seed();
    const entered = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const getAccount = CloudAccountRepo.getAccount.bind(CloudAccountRepo);
    vi.spyOn(CloudAccountRepo, 'getAccount').mockImplementationOnce(async (id) => {
      const snapshot = await getAccount(id);
      entered.resolve();
      await resume.promise;
      return snapshot;
    });
    const pending = observe(bindCloudIdentityProfileWithPayload(account.id, profile('old')));
    try {
      await entered.promise;
      await bindCloudIdentityProfileWithPayload(account.id, profile('winner'));
      const expected = await getAccount(account.id);
      resume.resolve();
      expect(await pending).toMatchObject({ error: { profileCode: 'profile-write-failed' } });
      expect(await getAccount(account.id)).toEqual(expected);
      expect(saveGlobalOriginalProfile).toHaveBeenCalledExactlyOnceWith(profile('winner'));
    } finally {
      resume.resolve();
      await pending;
    }
  });

  it('persists an initial automatic binding before preparing any client write', async () => {
    const account = await seed();
    await switchCloudAccountCore(account.id, 'agy');
    const current = await CloudAccountRepo.getAccount(account.id);
    expect(current?.device_profile).toEqual(profile('candidate'));
    expect(current?.device_history).toMatchObject([
      { profile: profile('candidate'), isCurrent: true },
    ]);
    expect(prepareClientAccountWrite).toHaveBeenCalledOnce();
    expect(saveGlobalOriginalProfile).toHaveBeenCalledExactlyOnceWith(profile('candidate'));
  });
  it.each([true, false])(
    'persists a missing bound profile from matching history with current=%s',
    async (isCurrent) => {
      const account = await seed();
      const revision = {
        id: 'existing',
        createdAt: 1,
        label: 'generated',
        profile: profile('history'),
        isCurrent,
      };
      await CloudAccountRepo.addAccount({ ...account, device_history: [revision] });
      await bindCloudIdentityProfileWithPayload(account.id, profile('history'));
      const stored = await CloudAccountRepo.getAccount(account.id);
      expect(stored?.device_profile).toEqual(profile('history'));
      expect(stored?.device_history).toEqual([{ ...revision, isCurrent: true }]);
      expect(stored?.lifecycle_generation).toBe(account.lifecycle_generation);
    },
  );
  it('keeps a committed binding visible when later baseline publication fails', async () => {
    const account = await seed();
    const error = Object.assign(new Error('synthetic baseline failure'), { code: 'ENOSPC' });
    vi.mocked(saveGlobalOriginalProfile).mockImplementationOnce(() => {
      throw error;
    });
    expect(await observe(bindCloudIdentityProfile(account.id, 'generate'))).toMatchObject({
      error: {
        profileCode: 'profile-write-failed',
        cause: error,
      },
    });
    const stored = await CloudAccountRepo.getAccount(account.id);
    expect(stored?.device_profile).toEqual(profile('candidate'));
    expect(stored?.device_history).toHaveLength(1);
    expect(generateDeviceProfile).toHaveBeenCalledOnce();
  });
  it('keeps repeated binding of the same profile idempotent', async () => {
    const account = await seed();
    await bindCloudIdentityProfileWithPayload(account.id, profile('same'));
    const expected = await CloudAccountRepo.getAccount(account.id);
    await bindCloudIdentityProfileWithPayload(account.id, profile('same'));
    expect(await CloudAccountRepo.getAccount(account.id)).toEqual(expected);
    expect(expected?.device_history).toHaveLength(1);
  });
});
