import type { CoreRpcClient } from '@/core/rpc/client';
import { agentToolsOwner } from '../agent-tools/agent-tools.owner';
import type { AgentToolsOperations } from '../agent-tools/agent-tools.service';

let selected: AgentToolsOperations = agentToolsOwner;
export function selectAgentToolsAdapter(
  selection:
    | { mode: 'desktop-embedded' }
    | { mode: 'standalone-core'; client: Pick<CoreRpcClient, 'agentTools'> },
) {
  selected = selection.mode === 'desktop-embedded' ? agentToolsOwner : selection.client.agentTools;
}
export function getAgentToolsAdapter(): AgentToolsOperations {
  return selected;
}
