import type { ManualUpdateCheckResult } from './types';

export function selectAutomaticUpdateResult({
  electronUpdaterResult,
  manualResult,
}: {
  electronUpdaterResult: ManualUpdateCheckResult;
  manualResult: ManualUpdateCheckResult;
}): ManualUpdateCheckResult {
  if (electronUpdaterResult.status === 'available') {
    return electronUpdaterResult;
  }

  if (manualResult.status === 'available') {
    return manualResult;
  }

  if (electronUpdaterResult.status === 'unsupported') {
    return manualResult;
  }

  return electronUpdaterResult;
}
