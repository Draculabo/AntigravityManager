import type { AntigravityAppTarget } from '@/shared/platform/antigravityAppTarget';
import type { DeviceProfile } from '@/modules/identity-profile/types';
import { logger } from '@/shared/logging/logger';
import { AppError } from '@/shared/errors/appError';
import type { PathResolutionOptions } from '@/shared/platform/paths';
import { prepareLaunchContext } from '../launchContext';
import { startFromContext } from '../launch';
import { stopFromContext } from '../stop';
import { processError } from '../processErrors';
import { prepareIdeHotSwitch } from '../ideHotSwitch';
import type { LaunchContext } from '../types';
import {
  applyDeviceProfile,
  ensureIdentityProfileStorage,
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
  launchContext?: LaunchContext;
  performSwitch: (pathOptions?: PathResolutionOptions) => Promise<void>;
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
  pathOptions?: PathResolutionOptions,
): void {
  if (!profile) {
    return;
  }

  try {
    syncTelemetryServiceMachineIdValue(profile.macMachineId, undefined, appTarget, pathOptions);
  } catch (error) {
    logger.warn('Skipping telemetry.serviceMachineId sync after SQLite token injection', error);
  }
}

function toSwitchFailureReason(stage: string, error: unknown): SwitchFailureReason {
  if (stage === 'close' || stage === 'hot_stop') {
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
  if (stage === 'start' || stage === 'hot_confirm') {
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
    launchContext,
    performSwitch,
    afterSwitchSuccess,
  } = options;

  let failureReason: SwitchFailureReason | null = null;
  let exitUnconfirmed = false;
  let stage = 'close';
  let switchMode = 'restart';
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
          await trace.phase('performSwitchMs', () => performSwitch());
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

        stage = 'preflight';
        const context =
          launchContext || (await prepareLaunchContext(appTarget === 'ide' ? 'ide' : 'classic'));
        const hotSession = !useCredentialStore ? await prepareIdeHotSwitch(context) : null;
        if (applyFingerprint) {
          if (!targetProfile) {
            stage = 'missing_profile';
            throw new Error('Account has no bound identity profile');
          }
          stage = 'apply';
          ensureIdentityProfileStorage(appTarget, context.pathOptions);
        }
        const writeSwitchState = async (applyProfile = true) => {
          if (applyProfile && applyFingerprint && targetProfile) {
            stage = 'apply';
            trace.phaseSync('applyProfileMs', () => {
              applyDeviceProfile(targetProfile, appTarget, context.pathOptions);
            });
          }
          stage = 'switch';
          await trace.phase('performSwitchMs', () => performSwitch(context.pathOptions));
          if (applyFingerprint && !useCredentialStore) {
            trace.phaseSync('syncTelemetryServiceMachineIdMs', () => {
              syncTelemetryServiceMachineIdBestEffort(
                targetProfile,
                appTarget,
                context.pathOptions,
              );
            });
          }
        };

        stage = 'preflight';
        let hotConfirmed = false;
        if (hotSession) {
          switchMode = 'hot';
          await writeSwitchState();
          try {
            stage = 'hot_stop';
            const stopped = await trace.phase('hotServiceStopMs', hotSession.stopServices);
            // The retiring service may flush cached credentials on exit. Reassert the selected
            // account before confirming its replacement; a failed rewrite is a partial switch.
            await writeSwitchState(false);
            if (stopped) {
              stage = 'hot_confirm';
              hotConfirmed = await trace.phase(
                'hotServiceConfirmMs',
                hotSession.confirmReplacement,
              );
            }
            if (!hotConfirmed) {
              await hotSession.assertCanRestart();
            }
          } catch (error) {
            logger.warn('IDE hot switch could not be confirmed', {
              stage,
              reason:
                error instanceof AppError
                  ? error.messageKey
                  : error instanceof Error
                    ? error.name
                    : 'unknown',
            });
            if (
              error instanceof AppError &&
              error.messageKey === 'process-runtime.switched-hot-unconfirmed'
            ) {
              throw error;
            }
            throw processError('switched-hot-unconfirmed');
          }
          if (!hotConfirmed) {
            switchMode = 'hot-fallback';
            logger.info(
              'IDE services did not recover within the deadline; restarting the captured IDE',
            );
          }
        }

        if (!hotConfirmed) {
          stage = 'close';
          await trace.phase('closeMs', async () => {
            try {
              await stopFromContext(context, processExitTimeoutMs);
            } catch (error) {
              exitUnconfirmed =
                error instanceof AppError &&
                error.messageKey === 'process-runtime.exit-unconfirmed';
              if (hotSession) {
                throw processError('switched-hot-unconfirmed');
              }
              throw error;
            }
          });

          await writeSwitchState();

          stage = 'start';
          await trace.phase('startMs', async () => {
            try {
              await startFromContext(context);
            } catch {
              throw processError('switched-startup-unconfirmed');
            }
          });
        }
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
      switchMode,
      exitUnconfirmed,
      failureReason,
    }),
  );
}
