import type { AntigravityAppTarget } from '@/shared/platform/antigravityAppTarget';
import type { DeviceProfile } from '@/modules/identity-profile/types';
import { logger } from '@/shared/logging/logger';
import { refreshAntigravityProcessCache } from '@/shared/platform/paths';
import {
  closeAntigravity,
  isProcessRunning,
  startAntigravity,
  _waitForProcessExit,
} from '@/modules/antigravity-runtime/ipc/handler';
import {
  applyDeviceProfile,
  syncTelemetryServiceMachineIdValue,
} from '@/modules/identity-profile/ipc/handler';
import {
  type SwitchFailureReason,
  recordSwitchFailure,
  recordSwitchSuccess,
} from '@/modules/antigravity-runtime/switch/switchMetrics';
import { withTimingTrace } from '@/shared/observability/timingTrace';

export interface SwitchFlowOptions {
  scope: 'local' | 'cloud';
  targetProfile: DeviceProfile | null;
  appTarget?: AntigravityAppTarget;
  applyFingerprint: boolean;
  useCredentialStore: boolean;
  processExitTimeoutMs: number;
  skipRefreshProcessCache?: boolean;
  performSwitch: () => Promise<void>;
  afterSwitchSuccess?: () => Promise<void>;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function applyDeviceProfileBestEffort(
  profile: DeviceProfile | null,
  appTarget: AntigravityAppTarget | undefined,
): void {
  if (!profile) {
    return;
  }

  try {
    applyDeviceProfile(profile, appTarget);
  } catch (error) {
    logger.warn(
      'Skipping device profile apply because credential-store-backed targets do not require storage.json',
      error,
    );
  }
}

function syncTelemetryServiceMachineIdBestEffort(
  profile: DeviceProfile | null,
  appTarget: AntigravityAppTarget | undefined,
): void {
  if (!profile) {
    return;
  }

  try {
    syncTelemetryServiceMachineIdValue(profile.macMachineId, undefined, appTarget);
  } catch (error) {
    logger.warn('Skipping telemetry.serviceMachineId sync after SQLite token injection', error);
  }
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
  const {
    scope,
    appTarget,
    targetProfile,
    applyFingerprint,
    useCredentialStore,
    processExitTimeoutMs,
    skipRefreshProcessCache = false,
    performSwitch,
    afterSwitchSuccess,
  } = options;

  let failureReason: SwitchFailureReason | null = null;
  let waitExitTimedOut = false;
  let stage = 'close';
  const isCliTarget = appTarget === 'agy';
  await withTimingTrace(
    'switch.execute',
    {
      scope,
      appTarget: appTarget || 'classic',
      processExitTimeoutMs,
    },
    async (trace) => {
      try {
        if (isCliTarget) {
          logger.info('Skipping GUI process steps for agy CLI switch');
          stage = 'switch';
          await trace.phase('performSwitchMs', performSwitch);
          if (applyFingerprint) {
            stage = 'apply';
            trace.phaseSync('applyProfileMs', () => {
              applyDeviceProfileBestEffort(targetProfile, appTarget);
            });
          }
          if (afterSwitchSuccess) {
            stage = 'after_success';
            await trace.phase('afterSwitchSuccessMs', afterSwitchSuccess);
          }
          recordSwitchSuccess(scope);
          return;
        }

        if (!skipRefreshProcessCache) {
          await trace.phase('refreshProcessCacheMs', async () => {
            await refreshAntigravityProcessCache(appTarget);
          });
        }

        const isRunning = await trace.phase('isProcessRunningMs', async () =>
          isProcessRunning(appTarget),
        );
        if (isRunning) {
          await trace.phase('closeMs', async () => {
            await closeAntigravity(appTarget);
          });
          try {
            await trace.phase('waitExitMs', async () => {
              await _waitForProcessExit(processExitTimeoutMs, 100, appTarget);
            });
          } catch (error) {
            waitExitTimedOut = true;
            logger.warn('Process did not exit cleanly within timeout, but proceeding...', error);
          }
        }

        if (useCredentialStore) {
          stage = 'switch';
          await trace.phase('performSwitchMs', performSwitch);
          if (applyFingerprint) {
            stage = 'apply';
            if (!targetProfile) {
              stage = 'missing_profile';
              throw new Error('Account has no bound identity profile');
            }
            trace.phaseSync('applyProfileMs', () => {
              applyDeviceProfile(targetProfile, appTarget);
            });
          }
        } else {
          if (applyFingerprint) {
            stage = 'apply';
            if (!targetProfile) {
              stage = 'missing_profile';
              throw new Error('Account has no bound identity profile');
            }
            trace.phaseSync('applyProfileMs', () => {
              applyDeviceProfile(targetProfile, appTarget);
            });
          } else if (!applyFingerprint) {
            logger.warn(
              'Identity profile apply is disabled by CRACK_IDENTITY_PROFILE_APPLY_ENABLED / CRACK_DEVICE_FINGERPRINT_ENABLED',
            );
          }

          stage = 'switch';
          await trace.phase('performSwitchMs', performSwitch);
          if (applyFingerprint) {
            trace.phaseSync('syncTelemetryServiceMachineIdMs', () => {
              syncTelemetryServiceMachineIdBestEffort(targetProfile, appTarget);
            });
          }
        }

        stage = 'start';
        await trace.phase('startMs', async () => {
          await startAntigravity(appTarget);
        });
        if (afterSwitchSuccess) {
          stage = 'after_success';
          await trace.phase('afterSwitchSuccessMs', afterSwitchSuccess);
        }
        recordSwitchSuccess(scope);
      } catch (error) {
        const reason = toSwitchFailureReason(stage, error);
        const message = getErrorMessage(error);
        failureReason = reason;
        recordSwitchFailure(scope, reason, message);
        throw error;
      }
    },
    () => ({
      stage,
      waitExitTimedOut,
      failureReason,
    }),
  );
}
