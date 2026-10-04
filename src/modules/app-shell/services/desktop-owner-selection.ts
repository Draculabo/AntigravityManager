import type { ManagementClient } from '@/core/management/client';
import type { CoreRpcClient } from '@/core/rpc/client';
import { selectCloudAccountAdapter } from '@/modules/cloud-account/ipc/cloud-account-adapter';
import { selectConfigAdapter } from '@/modules/config/ipc/config-adapter';
import { selectLocalAccountAdapter } from '@/modules/account/ipc/local-account-adapter';
import { selectGatewayAdapter } from '@/modules/proxy-gateway/ipc/gateway-adapter';
import { selectOpenCodeAdapter } from '@/modules/proxy-gateway/ipc/opencode-adapter';
import { selectAgentToolsAdapter } from '@/modules/proxy-gateway/ipc/agent-tools-adapter';
import { selectAuditAdapter } from '@/modules/proxy-gateway/ipc/audit-adapter';
import { selectAuditFileAdapter } from '@/modules/proxy-gateway/ipc/audit-file-adapter';
import { selectThoughtAdapter } from '@/modules/proxy-gateway/ipc/thought-adapter';
import { selectAuditCurlAdapter } from '@/modules/proxy-gateway/ipc/audit-curl-adapter';
import { selectIpcAuditAdapter } from '@/modules/proxy-gateway/ipc/ipc-audit-adapter';

type Selection =
  | { mode: 'desktop-embedded' }
  | { mode: 'standalone-core'; client: CoreRpcClient; management: ManagementClient };

/** Synchronous composition, before renderer admission; no observer can see a partial selection. */
export function selectDesktopOwners(selection: Selection): void {
  selectGatewayAdapter(selection);
  selectConfigAdapter(selection);
  selectLocalAccountAdapter(selection);
  selectOpenCodeAdapter(selection);
  selectAgentToolsAdapter(selection);
  selectAuditAdapter(selection);
  selectAuditFileAdapter(selection);
  selectThoughtAdapter(selection);
  selectAuditCurlAdapter(selection);
  selectIpcAuditAdapter(selection);
  selectCloudAccountAdapter(selection);
}
