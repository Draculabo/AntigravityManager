import type { SecurityStatus } from '@/shared/security/master-key-manager';

interface NormalizeSecurityStatusOptions {
  platform: NodeJS.Platform;
  safeStorageBackend?: string;
}

export function normalizeSecurityStatus(
  status: SecurityStatus,
  { platform, safeStorageBackend }: NormalizeSecurityStatusOptions,
): SecurityStatus {
  if (
    status.state === 'secure' &&
    status.masterKeySource === 'safeStorage' &&
    platform === 'linux' &&
    safeStorageBackend === 'basic_text'
  ) {
    return { ...status, state: 'degraded' };
  }

  return status;
}
