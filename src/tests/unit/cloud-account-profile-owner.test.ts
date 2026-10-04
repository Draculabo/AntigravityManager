import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRouterClient } from '@orpc/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ManagementServer } from '@/core/management/server';
import { CoreRpcClient } from '@/core/rpc/client';
import { createCoreRpcOperations } from '@/core/rpc/router';
import { cloudRouter } from '@/modules/cloud-account/ipc/router';
import { selectCloudAccountAdapter } from '@/modules/cloud-account/ipc/cloud-account-adapter';
import { CloudAccountDeviceBindingStore } from '@/modules/cloud-account/persistence/cloud-account-device-binding-store';
import { generateDeviceProfile } from '@/modules/identity-profile/ipc/handler';
import type { DeviceProfile, DeviceProfileVersion } from '@/modules/identity-profile/types';

const capture: DeviceProfile = {
  machineId: 'captured-machine',
  macMachineId: 'captured-mac',
  devDeviceId: 'captured-device',
  sqmId: '{CAPTURED}',
};
const generated: DeviceProfile = {
  machineId: 'generated-machine',
  macMachineId: 'generated-mac',
  devDeviceId: 'generated-device',
  sqmId: '{GENERATED}',
};
const accountId = '11111111-1111-4111-8111-111111111111';
const owner = vi.hoisted(() => ({
  bound: null as DeviceProfile | null,
  baseline: null as DeviceProfile | null,
  history: [] as DeviceProfileVersion[],
}));

vi.mock('@/modules/cloud-account/ipc/handler', () => ({}));
vi.mock('@/modules/cloud-account/services/cloud-account-switch.service', () => ({
  switchCloudAccountCore: vi.fn(),
}));
vi.mock('@/modules/cloud-account/persistence/cloudHandler', () => ({
  CloudAccountRepo: {
    getAccount: vi.fn(async (id: string) =>
      id === accountId
        ? { id, device_profile: owner.bound ?? undefined, device_history: owner.history }
        : null,
    ),
  },
}));
vi.mock('@/modules/cloud-account/persistence/cloud-account-device-binding-store', () => ({
  CloudAccountDeviceBindingStore: {
    setDeviceBinding: vi.fn((_id: string, profile: DeviceProfile, label: string) => {
      owner.history = owner.history.map((item) => ({ ...item, isCurrent: false }));
      owner.history.push({
        id: `revision-${owner.history.length + 1}`,
        createdAt: owner.history.length + 1,
        label,
        profile,
        isCurrent: true,
      });
      owner.bound = profile;
    }),
    restoreDeviceVersion: vi.fn(
      (_id: string, versionId: string, baseline: DeviceProfile | null) => {
        const profile =
          versionId === 'baseline'
            ? baseline
            : versionId === 'current'
              ? owner.bound
              : owner.history.find((item) => item.id === versionId)?.profile;
        if (!profile) {
          throw new Error(
            versionId === 'baseline'
              ? 'Global original profile not found'
              : 'Device profile version not found',
          );
        }
        owner.bound = profile;
        owner.history = owner.history.map((item) => ({
          ...item,
          isCurrent: item.id === versionId,
        }));
        return profile;
      },
    ),
    deleteDeviceVersion: vi.fn((_id: string, versionId: string) => {
      const revision = owner.history.find((item) => item.id === versionId);
      if (!revision) {
        throw new Error('Historical device profile not found');
      }
      if (revision.isCurrent) {
        throw new Error('Currently bound profile cannot be deleted');
      }
      owner.history = owner.history.filter((item) => item.id !== versionId);
    }),
  },
}));
vi.mock('@/modules/identity-profile/ipc/handler', () => ({
  readCurrentDeviceProfile: vi.fn(() => capture),
  generateDeviceProfile: vi.fn(() => generated),
  ensureGlobalOriginalFromCurrentStorage: vi.fn(() => {
    owner.baseline ??= capture;
  }),
  saveGlobalOriginalProfile: vi.fn((profile: DeviceProfile) => {
    owner.baseline ??= profile;
  }),
  loadGlobalOriginalProfile: vi.fn(() => owner.baseline),
}));
vi.mock('@/shared/logging/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

let server: ManagementServer | null = null;
let directory: string | null = null;

beforeEach(() => {
  owner.bound = null;
  owner.baseline = capture;
  owner.history = [];
  vi.clearAllMocks();
});

afterEach(async () => {
  selectCloudAccountAdapter({ mode: 'desktop-embedded' });
  await server?.close();
  server = null;
  if (directory) {
    await fs.rm(directory, { recursive: true, force: true });
    directory = null;
  }
});

async function startOwner(): Promise<CoreRpcClient> {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agm-profile-owner-'));
  const endpoint =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\agm-profile-owner-${path.basename(directory)}`
      : path.join(directory, 'core.sock');
  server = new ManagementServer({
    endpoint,
    getStatus: () => ({ state: 'running', pid: 123, gateway: { running: false, port: null } }),
    shutdown: async () => {},
    onShutdownError: vi.fn(),
    rpc: createCoreRpcOperations({ startGateway: vi.fn(), stopGateway: vi.fn() }),
  });
  await server.start();
  return new CoreRpcClient(endpoint);
}

async function rendererError(action: () => Promise<unknown>, expectedCode: string): Promise<void> {
  try {
    await action();
    expect.fail('Profile action should reject');
  } catch (error) {
    expect(error).toMatchObject({ data: { profileCode: expectedCode } });
    expect(JSON.stringify(error)).not.toMatch(/secret-path|private-provider/);
  }
}

describe('cloud identity profile owner', () => {
  it('keeps embedded and remote snapshots equal and persists capture, generate and supplied binding', async () => {
    const embedded = createRouterClient(cloudRouter);
    const initial = await embedded.getIdentityProfiles({ accountId });
    const client = await startOwner();
    selectCloudAccountAdapter({ mode: 'standalone-core', client });
    const remote = createRouterClient(cloudRouter);
    expect(await remote.getIdentityProfiles({ accountId })).toEqual(initial);

    expect(await remote.bindIdentityProfile({ accountId, mode: 'capture' })).toEqual(capture);
    expect(await client.getIdentityProfiles(accountId)).toMatchObject({ boundProfile: capture });
    expect(await remote.previewIdentityProfile()).toEqual(generated);
    expect(await remote.bindIdentityProfile({ accountId, mode: 'generate' })).toEqual(generated);
    expect(await remote.bindIdentityProfileWithPayload({ accountId, profile: capture })).toEqual(
      capture,
    );
    expect(await client.getIdentityProfiles(accountId)).toMatchObject({
      boundProfile: capture,
      history: [
        { id: 'revision-1', label: 'capture' },
        { id: 'revision-2', label: 'generate' },
        { id: 'revision-3', label: 'generated', isCurrent: true },
      ],
    });
    expect(CloudAccountDeviceBindingStore.setDeviceBinding).toHaveBeenCalledTimes(3);
  });

  it('restores a revision and baseline, then deletes a non-current revision', async () => {
    const client = await startOwner();
    await client.bindIdentityProfile(accountId, 'capture');
    await client.bindIdentityProfile(accountId, 'generate');
    expect(await client.restoreIdentityProfileRevision(accountId, 'revision-1')).toEqual(capture);
    expect(await client.restoreBaselineProfile(accountId)).toEqual(capture);
    await client.deleteIdentityProfileRevision(accountId, 'revision-2');
    expect(await client.getIdentityProfiles(accountId)).toMatchObject({
      boundProfile: capture,
      history: [{ id: 'revision-1' }],
    });
  });

  it('returns stable owner errors without stored paths or provider details', async () => {
    const client = await startOwner();
    selectCloudAccountAdapter({ mode: 'standalone-core', client });
    const renderer = createRouterClient(cloudRouter);
    await rendererError(
      () => renderer.getIdentityProfiles({ accountId: 'missing' }),
      'account-not-found',
    );
    owner.baseline = null;
    await rendererError(
      () => renderer.restoreBaselineProfile({ accountId }),
      'baseline-unavailable',
    );
    await rendererError(
      () => renderer.restoreIdentityProfileRevision({ accountId, versionId: 'missing' }),
      'revision-not-found',
    );
    await renderer.bindIdentityProfile({ accountId, mode: 'capture' });
    await rendererError(
      () => renderer.deleteIdentityProfileRevision({ accountId, versionId: 'revision-1' }),
      'profile-invalid',
    );
    vi.mocked(CloudAccountDeviceBindingStore.setDeviceBinding).mockImplementationOnce(() => {
      throw new Error('secret-path');
    });
    await rendererError(
      () => renderer.bindIdentityProfile({ accountId, mode: 'generate' }),
      'profile-write-failed',
    );
    vi.mocked(generateDeviceProfile).mockImplementationOnce(() => {
      throw new Error('private-provider');
    });
    await rendererError(() => renderer.previewIdentityProfile(), 'profile-operation-failed');
  });

  it('rejects malformed IDs and profiles before owner mutation', async () => {
    const client = await startOwner();
    await expect(client.getIdentityProfiles('')).rejects.toThrow();
    await expect(client.restoreIdentityProfileRevision(accountId, '')).rejects.toThrow();
    await expect(
      client.bindIdentityProfileWithPayload(accountId, {
        ...capture,
        machineId: '',
      }),
    ).rejects.toThrow();
    expect(CloudAccountDeviceBindingStore.setDeviceBinding).not.toHaveBeenCalled();
  });
});
