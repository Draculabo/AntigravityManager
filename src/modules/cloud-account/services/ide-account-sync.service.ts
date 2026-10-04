import {
  AGY_SYNC_FROM_IDE_UNSUPPORTED_MESSAGE,
  IdeAccountImportAdapter,
} from '@/modules/cloud-account/persistence/ide-account-import-adapter';
import {
  projectCloudAccountView,
  type CloudAccountView,
} from '@/modules/cloud-account/services/cloud-account-view';
import { type AntigravityAppTarget } from '@/shared/platform/antigravityAppTarget';
import type { IdeAccountSyncErrorCode } from './ide-account-sync.schema';

export class IdeAccountSyncError extends Error {
  constructor(readonly syncCode: IdeAccountSyncErrorCode) {
    super('IDE account sync failed');
    this.name = 'IdeAccountSyncError';
  }
}

export function classifyIdeAccountSyncError(error: unknown): IdeAccountSyncErrorCode {
  if (error instanceof IdeAccountSyncError) {
    return error.syncCode;
  }
  const message = error instanceof Error ? error.message.toLowerCase() : '';
  if (message.includes(AGY_SYNC_FROM_IDE_UNSUPPORTED_MESSAGE.toLowerCase())) {
    return 'agy-unsupported';
  }
  if (
    message.includes('unauthenticated') ||
    message.includes('unauthorized') ||
    message.includes('token may be expired') ||
    message.includes('re-login in antigravity ide')
  ) {
    return 'reauth-required';
  }
  if (
    message.includes('no cloud account found in ide') ||
    message.includes('no oauth token found in ide state') ||
    message.includes('ide oauth access token is empty')
  ) {
    return 'no-ide-account';
  }
  if (
    message.includes('antigravity database not found') ||
    message.includes('sqlite_') ||
    message.includes('database is locked') ||
    message.includes('unable to open database')
  ) {
    return 'ide-database-unavailable';
  }
  return 'sync-failed';
}

/** Import and projection run in the process that owns account persistence. */
export async function syncIdeAccountView(
  appTarget?: AntigravityAppTarget,
): Promise<CloudAccountView | null> {
  try {
    const account = await IdeAccountImportAdapter.syncFromIde(appTarget);
    return account ? projectCloudAccountView(account) : null;
  } catch (error) {
    throw new IdeAccountSyncError(classifyIdeAccountSyncError(error));
  }
}
