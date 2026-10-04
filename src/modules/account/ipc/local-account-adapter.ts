import type { CoreRpcClient } from '@/core/rpc/client';
import {
  localAccountOwner,
  type LocalAccountOperations,
} from '../services/local-account-owner.service';

let selected: LocalAccountOperations = localAccountOwner;
/** Select with the other account/configuration adapters before desktop initialization. */
export function selectLocalAccountAdapter(
  selection:
    | { mode: 'desktop-embedded' }
    | { mode: 'standalone-core'; client: Pick<CoreRpcClient, 'localAccounts'> },
): void {
  selected =
    selection.mode === 'desktop-embedded' ? localAccountOwner : selection.client.localAccounts;
}
export function getLocalAccountAdapter(): LocalAccountOperations {
  return selected;
}
