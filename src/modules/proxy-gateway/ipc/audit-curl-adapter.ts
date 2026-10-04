import type { CoreRpcClient } from '@/core/rpc/client';
import {
  auditCurlOwner,
  type AuditCurlOperations,
} from '../traffic-monitor/audit-curl-owner.service';
let selected: AuditCurlOperations = auditCurlOwner;
export function selectAuditCurlAdapter(
  selection:
    | { mode: 'desktop-embedded' }
    | { mode: 'standalone-core'; client: Pick<CoreRpcClient, 'auditCurl'> },
): void {
  selected = selection.mode === 'desktop-embedded' ? auditCurlOwner : selection.client.auditCurl;
}
export function getAuditCurlAdapter(): AuditCurlOperations {
  return selected;
}
