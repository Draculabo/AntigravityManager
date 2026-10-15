import { launchDetachedCore } from '@/cli/service-launcher';
import { app } from 'electron';
import path from 'node:path';
import { desktopPreferencesStore } from '@/modules/config/ipc/desktop-preferences';
import { ManagementClient } from '@/core/management/client';
import type { CoreHandshake } from '@/core/management/handshake';
import { CoreRpcClient } from '@/core/rpc/client';
import { selectDesktopOwners } from './desktop-owner-selection';
import { standaloneCoreConnection } from './standalone-core-connection';

/** Uses a standalone Node executable. Electron's native ABI/runtime is never used for the core. */
export function desktopCoreConnection(coreEntry: string, executable: string) {
  const connection = standaloneCoreConnection();
  const { endpoint } = connection;
  return {
    ...connection,
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
  };
}
