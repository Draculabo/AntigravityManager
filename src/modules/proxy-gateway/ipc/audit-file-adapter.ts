import type { CoreRpcClient } from '@/core/rpc/client';
import { auditFileOwner, type AuditFileOperations } from '../audit/audit-file-owner.service';
let selected: AuditFileOperations = auditFileOwner;

export function selectAuditFileAdapter(
  selection:
    | { mode: 'desktop-embedded' }
    | { mode: 'standalone-core'; client: Pick<CoreRpcClient, 'auditFile'> },
): void {
  selected = selection.mode === 'desktop-embedded' ? auditFileOwner : selection.client.auditFile;
}
export function getAuditFileAdapter(): AuditFileOperations {
  return selected;
}
