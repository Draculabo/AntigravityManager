import type { CoreRpcClient } from '@/core/rpc/client';
import { auditOwner, type AuditOperations } from '../audit/audit-owner.service';

let selected: AuditOperations = auditOwner;
export function selectAuditAdapter(
  selection:
    | { mode: 'desktop-embedded' }
    | { mode: 'standalone-core'; client: Pick<CoreRpcClient, 'audit'> },
): void {
  selected = selection.mode === 'desktop-embedded' ? auditOwner : selection.client.audit;
}
export function getAuditAdapter(): AuditOperations {
  return selected;
}
