import type { CoreRpcClient } from '@/core/rpc/client';
import { connectionProfilesOwner, type ConnectionProfilesOperations } from '../connection-profiles/connection-profiles.owner';

let selected: ConnectionProfilesOperations = connectionProfilesOwner;
export function selectConnectionProfilesAdapter(selection: { mode: 'desktop-embedded' } | { mode: 'standalone-core'; client: Pick<CoreRpcClient, 'connectionProfiles'> }): void {
  selected = selection.mode === 'desktop-embedded' ? connectionProfilesOwner : selection.client.connectionProfiles;
}
export function getConnectionProfilesAdapter(): ConnectionProfilesOperations { return selected; }
