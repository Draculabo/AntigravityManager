import type { CoreRpcClient } from '@/core/rpc/client';
import { clientConfigOwner, type ClientConfigOperations } from '../agent-tools/client-config-owner.service';

let selected: ClientConfigOperations = clientConfigOwner;
export function selectClientConfigAdapter(
  selection: { mode: 'desktop-embedded' } | { mode: 'standalone-core'; client: Pick<CoreRpcClient, 'clientConfig'> },
): void {
  selected = selection.mode === 'desktop-embedded' ? clientConfigOwner : selection.client.clientConfig;
}
export function getClientConfigAdapter(): ClientConfigOperations {
  return selected;
}
