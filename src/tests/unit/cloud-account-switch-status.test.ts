import { createRouterClient } from '@orpc/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CoreRpcClient } from '@/core/rpc/client';
import { createCoreRpcOperations } from '@/core/rpc/router';
import { cloudRouter } from '@/modules/cloud-account/ipc/router';
import { selectCloudAccountAdapter } from '@/modules/cloud-account/ipc/cloud-account-adapter';
import { getCloudAccountSwitchStatus } from '@/modules/cloud-account/services/cloud-account-switch-status.service';
import { CloudAccountSwitchStatusSchema } from '@/modules/cloud-account/services/cloud-account-switch-status.schema';
import { getDeviceHardeningSnapshot } from '@/modules/identity-profile/ipc/handler';
import {
  recordSwitchFailure,
  recordSwitchSuccess,
} from '@/modules/antigravity-runtime/switch/switchMetrics';

vi.mock('@/modules/cloud-account/ipc/handler', () => ({}));
afterEach(() => {
  selectCloudAccountAdapter({ mode: 'desktop-embedded' });
  vi.restoreAllMocks();
});

describe('switch diagnostics boundary', () => {
  it('preserves embedded counters and pure hardening reads with explicit process provenance', async () => {
    selectCloudAccountAdapter({ mode: 'desktop-embedded' });
    const hardening = getDeviceHardeningSnapshot();
    const before = getCloudAccountSwitchStatus();
    recordSwitchSuccess('cloud');
    recordSwitchFailure('local', 'unknown', 'private provider body and C:\\credential.sqlite');
    const status = await createRouterClient(cloudRouter).getSwitchStatus();
    expect(status.metrics.cloud.switchSuccess).toBe(before.metrics.cloud.switchSuccess + 1);
    expect(status.metrics.local.switchFailure).toBe(before.metrics.local.switchFailure + 1);
    expect(status.hardening).toEqual(hardening);
    expect(getDeviceHardeningSnapshot()).toEqual(hardening);
    expect(status.epoch).toBe(before.epoch);
    expect(JSON.stringify(status)).not.toMatch(/private provider|credential.sqlite/);
  });
  it('returns stable unavailable errors without embedded fallback', async () => {
    const client = new CoreRpcClient(
      process.platform === 'win32'
        ? '\\\\.\\pipe\\agm-status-missing'
        : '/tmp/agm-status-missing.sock',
      50,
    );
    selectCloudAccountAdapter({ mode: 'standalone-core', client });
    await expect(createRouterClient(cloudRouter).getSwitchStatus()).rejects.toMatchObject({
      data: { diagnosticsCode: 'unavailable' },
      message: 'Account switch diagnostics are unavailable.',
    });
  });
  it('rejects malformed, oversized and arbitrary diagnostic fields', () => {
    const status = getCloudAccountSwitchStatus();
    expect(CloudAccountSwitchStatusSchema.safeParse({ ...status, token: 'private' }).success).toBe(
      false,
    );
    expect(
      CloudAccountSwitchStatusSchema.safeParse({
        ...status,
        guard: {
          ...status.guard,
          pendingOwners: Array.from({ length: 129 }, () => 'cloud-account-switch'),
        },
      }).success,
    ).toBe(false);
    expect(
      CloudAccountSwitchStatusSchema.safeParse({
        ...status,
        metrics: { ...status.metrics, cloud: { ...status.metrics.cloud, switchSuccess: Infinity } },
      }).success,
    ).toBe(false);
    expect(
      CloudAccountSwitchStatusSchema.safeParse({
        ...status,
        hardening: { ...status.hardening, lastFailureStage: 'C:\\private.sqlite' },
      }).success,
    ).toBe(false);
  });
  it('keeps diagnostics outside account-mutation admission and drain', async () => {
    const operations = createCoreRpcOperations({ startGateway: vi.fn(), stopGateway: vi.fn() });
    operations.closeAccountMutationAdmission();
    const before = operations.accountSwitchStatus();
    await operations.drainAccountMutations();
    expect(operations.accountSwitchStatus()).toEqual(before);
  });
  it('starts a fresh epoch and process counters when the owner module is restarted', async () => {
    const old = getCloudAccountSwitchStatus();
    vi.resetModules();
    const restarted =
      await import('@/modules/cloud-account/services/cloud-account-switch-status.service');
    const status = restarted.getCloudAccountSwitchStatus();
    expect(status.epoch).not.toBe(old.epoch);
    expect(status.metrics.cloud.switchSuccess).toBe(0);
    expect(status.metrics.local.switchFailure).toBe(0);
  });
});
