import type { CoreRpcClient } from '@/core/rpc/client';
import { openCodeOwner, type OpenCodeOperations } from '../opencode-sync/opencode-owner.service';
let selected: OpenCodeOperations = openCodeOwner;
export function selectOpenCodeAdapter(
  selection:
    | { mode: 'desktop-embedded' }
    | { mode: 'standalone-core'; client: Pick<CoreRpcClient, 'openCode'> },
): void {
  selected = selection.mode === 'desktop-embedded' ? openCodeOwner : selection.client.openCode;
}
export function getOpenCodeAdapter(): OpenCodeOperations {
  return selected;
}
