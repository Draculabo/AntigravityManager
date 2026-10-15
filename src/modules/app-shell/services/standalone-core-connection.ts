import { ServiceLauncher } from '@/cli/service-launcher';
import { setTimeout as delay } from 'node:timers/promises';
import { getManagementEndpoint } from '@/core/management/endpoint';
import { ManagementClient } from '@/core/management/client';
import { getProfileFingerprint, type CoreHandshake } from '@/core/management/handshake';
import { getProfileOwnershipEndpoint, probeProfileOwner } from '@/core/ownership/profile-lease';

/** Profile-scoped connection and terminal drain, without Electron or owner-local stores. */
export function standaloneCoreConnection() {
  const endpoint = getManagementEndpoint();
  const ownerEndpoint = getProfileOwnershipEndpoint();
  return {
    endpoint,
    management: new ManagementClient(endpoint),
    profile: getProfileFingerprint(),
    probeProfileOwner: () => probeProfileOwner(ownerEndpoint),
    stopVerifiedCore: async (handshake: CoreHandshake) => {
      const management = new ManagementClient(endpoint, undefined, handshake.epoch);
      const current = await management.handshake();
      if (current.epoch !== handshake.epoch || current.profile !== handshake.profile) {
        throw new Error('Core owner changed');
      }
      const launcher = new ServiceLauncher({
        management,
        probeProfileOwner: () => probeProfileOwner(ownerEndpoint),
        launchCore: async () => {
          throw new Error('Shutdown cannot launch a core');
        },
      });
      await launcher.stop();
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const owner = await probeProfileOwner(ownerEndpoint);
        if (!owner || owner.pid !== handshake.pid) {
          return;
        }
        await delay(100);
      }
      throw new Error('Core profile drain did not complete before the deadline');
    },
  };
}
