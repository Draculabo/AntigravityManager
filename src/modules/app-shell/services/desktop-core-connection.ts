import { launchDetachedCore, ServiceLauncher } from '@/cli/service-launcher';
import { app } from 'electron';
import path from 'node:path';
import { desktopPreferencesStore } from '@/modules/config/ipc/desktop-preferences';
import { setTimeout as delay } from 'node:timers/promises';
import { getManagementEndpoint } from '@/core/management/endpoint';
import { ManagementClient } from '@/core/management/client';
import { getProfileFingerprint, type CoreHandshake } from '@/core/management/handshake';
import { getProfileOwnershipEndpoint, probeProfileOwner } from '@/core/ownership/profile-lease';
import { CoreRpcClient } from '@/core/rpc/client';
import { selectDesktopOwners } from './desktop-owner-selection';

/** Uses a standalone Node executable. Electron's native ABI/runtime is never used for the core. */
export function desktopCoreConnection(coreEntry: string, executable: string) {
  const endpoint = getManagementEndpoint();
  const ownerEndpoint = getProfileOwnershipEndpoint();
  return {
    management: new ManagementClient(endpoint),
    profile: getProfileFingerprint(),
    probeProfileOwner: () => probeProfileOwner(ownerEndpoint),
    launchCore: () =>
      launchDetachedCore(
        coreEntry,
        executable,
        path.join(app.getPath('userData'), 'desktop-preferences.json'),
        process.env.SENTRY_DSN,
      ),
    selectStandaloneCore: async (handshake: CoreHandshake) => {
      const client = new CoreRpcClient(endpoint, undefined, handshake.epoch);
      const preferences = await desktopPreferencesStore.load();
      await client.setErrorReportingEnabled(preferences.error_reporting_enabled);
      selectDesktopOwners({
        mode: 'standalone-core',
        client,
        management: new ManagementClient(endpoint, undefined, handshake.epoch),
      });
    },
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
