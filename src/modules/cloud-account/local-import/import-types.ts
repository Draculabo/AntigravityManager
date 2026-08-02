export type LocalAccountImportAction = 'created' | 'updated';

export type LocalAccountImportFailureCode =
  | 'credential-unavailable'
  | 'identity-required'
  | 'identity-conflict'
  | 'persistence-failed';

export interface ImportedLocalAccount {
  fingerprint: string;
  accountId: string;
  email: string;
  action: LocalAccountImportAction;
}

export interface SkippedLocalAccount {
  fingerprint: string;
  accountId: string;
  email: string;
  reason: 'unchanged';
}

export interface FailedLocalAccountImport {
  fingerprint: string;
  email?: string;
  code: LocalAccountImportFailureCode;
  message: string;
}

export interface LocalAccountImportResult {
  imported: ImportedLocalAccount[];
  skipped: SkippedLocalAccount[];
  failed: FailedLocalAccountImport[];
  postImportTaskId?: string;
}

export type LocalAccountPostImportTaskStatus = 'queued' | 'running' | 'completed';

export type LocalAccountPostImportCacheReloadStatus = 'pending' | 'reloaded' | 'skipped' | 'failed';

export interface LocalAccountPostImportTaskSnapshot {
  taskId: string;
  status: LocalAccountPostImportTaskStatus;
  totalAccounts: number;
  completedAccounts: number;
  refreshedAccountIds: string[];
  failedAccountIds: string[];
  cacheReloadStatus: LocalAccountPostImportCacheReloadStatus;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
}
