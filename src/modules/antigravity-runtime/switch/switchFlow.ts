import type { AntigravityAppTarget } from '@/modules/account/types';
import type { DeviceProfile } from '@/modules/identity-profile/types';
import { logger } from '@/shared/logging/logger';
import { refreshAntigravityProcessCache } from '@/shared/platform/paths';
import {
  closeAntigravity,
  startAntigravity,
  _waitForProcessExit,
} from '@/modules/antigravity-runtime/ipc/handler';
import { applyDeviceProfile } from '@/modules/identity-profile/ipc/handler';
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
  processExitTimeoutMs: number;
  skipRefreshProcessCache?: boolean;
  performSwitch: () => Promise<void>;
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
  const {
    scope,
    appTarget,
    targetProfile,
    applyFingerprint,
    processExitTimeoutMs,
    skipRefreshProcessCache = false,
    performSwitch,
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
          logger.info('Skipping GUI process and device profile steps for agy CLI switch');
        } else {
          if (!skipRefreshProcessCache) {
            await trace.phase('refreshProcessCacheMs', async () => {
              await refreshAntigravityProcessCache(appTarget);
            });
          }
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

          stage = 'apply';
          if (applyFingerprint) {
            if (!targetProfile) {
              stage = 'missing_profile';
              throw new Error('Account has no bound identity profile');
            }
            trace.phaseSync('applyProfileMs', () => {
              applyDeviceProfile(targetProfile, appTarget);
            });
          } else {
            logger.warn(
              'Identity profile apply is disabled by CRACK_IDENTITY_PROFILE_APPLY_ENABLED / CRACK_DEVICE_FINGERPRINT_ENABLED',
            );
          }
        }

        stage = 'switch';
        await trace.phase('performSwitchMs', performSwitch);
        if (!isCliTarget) {
          stage = 'start';
          await trace.phase('startMs', async () => {
            await startAntigravity(appTarget);
          });
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
