import { describe, expect, it, vi } from 'vitest';
import { createCoreRpcOperations } from '@/core/rpc/router';
import { switchCloudAccountCore } from '@/modules/cloud-account/services/cloud-account-switch.service';
import { bindCloudIdentityProfile } from '@/modules/cloud-account/services/cloud-account-identity-profile.service';

vi.mock('@/modules/cloud-account/services/cloud-account-switch.service', () => ({
  switchCloudAccountCore: vi.fn(),
}));
vi.mock(
  '@/modules/cloud-account/services/cloud-account-identity-profile.service',
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import('@/modules/cloud-account/services/cloud-account-identity-profile.service')
    >()),
    bindCloudIdentityProfile: vi.fn(),
  }),
);

describe('core cloud account switch lifecycle', () => {
  it('drains admitted switching and rejects new mutations after admission closes', async () => {
    let finishSwitch: () => void = () => {};
    const pending = new Promise<void>((resolve) => {
      finishSwitch = resolve;
    });
    vi.mocked(switchCloudAccountCore).mockReturnValueOnce(pending);
    const operations = createCoreRpcOperations({
      startGateway: vi.fn(),
      stopGateway: vi.fn(),
    });

    const switching = operations.accountSwitch('account-1', 'agy');
    expect(switchCloudAccountCore).toHaveBeenCalledExactlyOnceWith('account-1', 'agy');
    operations.closeAccountMutationAdmission();
    let drained = false;
    const draining = operations.drainAccountMutations().then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);
    await expect(operations.accountSwitch('account-2')).rejects.toThrow('shutting down');
    expect(switchCloudAccountCore).toHaveBeenCalledTimes(1);

    finishSwitch();
    expect(await switching).toEqual({ success: true });
    await draining;
    expect(drained).toBe(true);
  });

  it('drains admitted profile binding before account ownership closes', async () => {
    let finishBind: (profile: {
      machineId: string;
      macMachineId: string;
      devDeviceId: string;
      sqmId: string;
    }) => void = () => {};
    const pending = new Promise<{
      machineId: string;
      macMachineId: string;
      devDeviceId: string;
      sqmId: string;
    }>((resolve) => {
      finishBind = resolve;
    });
    vi.mocked(bindCloudIdentityProfile).mockReturnValueOnce(pending);
    const operations = createCoreRpcOperations({
      startGateway: vi.fn(),
      stopGateway: vi.fn(),
    });
    const profile = {
      machineId: 'machine',
      macMachineId: 'mac',
      devDeviceId: 'device',
      sqmId: '{SQM}',
    };

    const binding = operations.accountProfileBind('account-1', 'capture');
    operations.closeAccountMutationAdmission();
    let drained = false;
    const draining = operations.drainAccountMutations().then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);
    await expect(operations.accountProfileBind('account-2', 'generate')).rejects.toThrow(
      'shutting down',
    );
    finishBind(profile);
    expect(await binding).toEqual(profile);
    await draining;
    expect(drained).toBe(true);
    expect(bindCloudIdentityProfile).toHaveBeenCalledExactlyOnceWith('account-1', 'capture');
  });
});
