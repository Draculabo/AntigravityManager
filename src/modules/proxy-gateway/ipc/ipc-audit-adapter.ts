import type { CoreRpcClient } from '@/core/rpc/client';
import { selectIpcAuditRecorder } from '../audit/ipc-audit-recorder';
import { createRemoteIpcAuditRecorder } from '../audit/remote-ipc-audit-recorder';

export function selectIpcAuditAdapter(
  selection: { mode: 'desktop-embedded' } | { mode: 'standalone-core'; client: CoreRpcClient },
): void {
  selectIpcAuditRecorder(
    selection.mode === 'standalone-core'
      ? createRemoteIpcAuditRecorder(selection.client)
      : undefined,
  );
}
