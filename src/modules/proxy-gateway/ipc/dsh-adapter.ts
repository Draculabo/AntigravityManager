import type { CoreRpcClient } from '@/core/rpc/client';
import { dshOwner, type DshOperations } from '../dsh-sync/dsh-owner.service';

let selected: DshOperations = dshOwner;
export function selectDshAdapter(
  selection:
    | { mode: 'desktop-embedded' }
    | { mode: 'standalone-core'; client: Pick<CoreRpcClient, 'dsh'> },
): void {
  selected = selection.mode === 'desktop-embedded' ? dshOwner : selection.client.dsh;
}
export function getDshAdapter(): DshOperations {
  return selected;
}
