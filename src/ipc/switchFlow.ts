import { type DeviceProfile } from '../types/account';
import { logger } from '../utils/logger';
import { closeAntigravity, startAntigravity, _waitForProcessExit } from './process/handler';
import { applyDeviceProfile } from './device/handler';
import {
  type SwitchFailureReason,
  recordSwitchFailure,
  recordSwitchSuccess,
} from './switchMetrics';
import type { IdeEdition } from '../types/config';

export interface SwitchFlowOptions {
  scope: 'local' | 'cloud';
  targetProfile: DeviceProfile | null;
  applyFingerprint: boolean;
  processExitTimeoutMs: number;
  edition?: IdeEdition;
  performSwitch: (edition?: IdeEdition) => Promise<void>;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function toSwitchFailureReason(stage: string, error: unknown): SwitchFailureReason {
  if (stage === 'close') {
    return 'process_close_failed';
  }
  if (stage === 'missing_profile') {
    return 'missing_bound_profile';
  }
  if (stage === 'apply') {
    return 'apply_device_profile_failed';
  }
  if (stage === 'switch') {
    return 'perform_switch_failed';
  }
  if (stage === 'start') {
    return 'start_process_failed';
  }

  // Keep legacy compatibility with reason encoded in thrown errors.
  if (error instanceof Error && error.message.includes('missing bound device profile')) {
    return 'missing_bound_profile';
  }
  if (error instanceof Error && error.message.includes('device_apply_failed')) {
    return 'apply_device_profile_failed';
  }
  return 'unknown';
}

export async function executeSwitchFlow(options: SwitchFlowOptions): Promise<void> {
  const { scope, targetProfile, applyFingerprint, processExitTimeoutMs, edition, performSwitch } = options;

  let stage = 'close';
  try {
    await closeAntigravity(edition);
    try {
      await _waitForProcessExit(processExitTimeoutMs, 100, edition);
    } catch (error) {
      logger.warn('Process did not exit cleanly within timeout, but proceeding...', error);
    }

    stage = 'apply';
    if (applyFingerprint) {
      if (!targetProfile) {
        stage = 'missing_profile';
        throw new Error('Account has no bound identity profile');
      }
      applyDeviceProfile(targetProfile);
    } else {
      logger.warn(
        'Identity profile apply is disabled by CRACK_IDENTITY_PROFILE_APPLY_ENABLED / CRACK_DEVICE_FINGERPRINT_ENABLED',
      );
    }

    stage = 'switch';
    await performSwitch(edition);
    stage = 'start';
    await startAntigravity(edition);
    recordSwitchSuccess(scope);
  } catch (error) {
    const reason = toSwitchFailureReason(stage, error);
    const message = getErrorMessage(error);
    recordSwitchFailure(scope, reason, message);
    throw error;
  }
}
