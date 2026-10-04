import { ORPCError } from '@orpc/server';
import { classifyIdeAccountSyncError } from './ide-account-sync.service';
import { readIdeAccountSyncErrorCode } from './ide-account-sync.schema';

export function toSyncLocalAccountORPCError(error: unknown) {
  const syncCode = readIdeAccountSyncErrorCode(error) ?? classifyIdeAccountSyncError(error);
  const code =
    syncCode === 'reauth-required'
      ? 'UNAUTHORIZED'
      : syncCode === 'ide-database-unavailable'
        ? 'SERVICE_UNAVAILABLE'
        : syncCode === 'sync-failed'
          ? 'INTERNAL_SERVER_ERROR'
          : 'BAD_REQUEST';
  return new ORPCError(code, {
    message: 'IDE account sync failed',
    data: { syncCode },
  });
}
