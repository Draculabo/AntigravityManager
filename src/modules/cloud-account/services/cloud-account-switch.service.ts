import {
  prepareLaunchContext,
  prepareClientAccountWrite,
  type ClientAccountStorage,
} from '@/modules/antigravity-runtime';
import { accountOwnerEvents } from './account-owner-events.service';
import { isEmpty, isString } from 'lodash-es';
import { CloudAccountRepo } from '@/modules/cloud-account/persistence/cloudHandler';
import { CloudAccountDeviceBindingStore } from '@/modules/cloud-account/persistence/cloud-account-device-binding-store';
import type { CloudAccount } from '@/modules/cloud-account/types';
import { logger } from '@/shared/logging/logger';
import {
  ensureGlobalOriginalFromCurrentStorage,
  generateDeviceProfile,
  isIdentityProfileApplyEnabled,
  saveGlobalOriginalProfile,
} from '@/modules/identity-profile/ipc/handler';
import { runWithSwitchGuard } from '@/modules/antigravity-runtime/switch/switchGuard';
import { executeSwitchFlow } from '@/modules/antigravity-runtime/switch/switchFlow';
import type { SwitchFailureReason } from '@/modules/antigravity-runtime/switch/switchMetrics';
import {
  CloudAccountSwitchContext,
  ensureCloudSwitchProjectReady,
} from './cloud-account-switch-context';
import { CloudAccountRefreshContextChangedError } from './cloud-account-refresh-context';
import type { AntigravityAppTarget } from '@/shared/platform/antigravityAppTarget';
import { extractErrorMessage } from '@/modules/cloud-account/utils/account-status';
import { withTimingTrace } from '@/shared/observability/timingTrace';
import {
  CloudAccountRefreshBlockedError,
  CloudAccountRefreshService,
  createCloudAccountRefreshRequest,
  isRetryableInvalidGrantRefreshError,
} from './CloudAccountRefreshService';
import {
  markAccountStatusFromError,
  mergeRefreshedToken,
} from './cloud-account-refresh-state.service';
import { CloudAccountSwitchError } from './cloud-account-switch.error';
import type { CloudAccountSwitchErrorCode } from './cloud-account-switch.schema';
import { OperationContext } from '@/shared/observability/operationContext';
import {
  CloudSwitchDiagnosticSchema,
  type CloudSwitchDiagnostic,
} from './operation-diagnostic.schema';
import { classifyOperationCause } from './operation-cause';
import { CredentialReadbackError } from '@/shared/auth/credentialReadbackError';
import { AppError } from '@/shared/errors/appError';
import { captureDeviceBindingWriteGuard } from './cloud-account-device-binding-guard';

type SwitchStage =
  | 'account-lookup'
  | 'launch-preflight'
  | 'identity-profile'
  | 'token-refresh'
  | 'enterprise-project'
  | 'target-prepare'
  | 'switch-execution'
  | 'account-state-update';

export interface CloudAccountSwitchOptions {
  diagnosticId?: string;
  presentationReason?: 'manual' | 'auto';
  onSuccess?(account: CloudAccount): Promise<void> | void;
}

function publicFailureCode(reason: SwitchFailureReason): CloudAccountSwitchErrorCode {
  switch (reason) {
    case 'missing_bound_profile':
    case 'apply_device_profile_failed':
      return 'identity-profile-required';
    case 'process_close_failed':
      return 'process-close-failed';
    case 'start_process_failed':
      return 'process-control-failed';
    case 'perform_switch_failed':
      return 'target-write-failed';
    default:
      return 'switch-failed';
  }
}

function diagnosticStageFor(
  stage: SwitchStage,
  reason: SwitchFailureReason,
  error?: unknown,
): CloudSwitchDiagnostic['stage'] {
  if (error instanceof CredentialReadbackError) {
    return 'credential-readback';
  }
  switch (reason) {
    case 'process_close_failed':
      return 'process-close';
    case 'start_process_failed':
      return 'process-start';
    case 'apply_device_profile_failed':
    case 'missing_bound_profile':
      return 'identity-preparation';
    case 'perform_switch_failed':
      return 'target-write';
  }
  switch (stage) {
    case 'account-lookup':
      return 'account-load';
    case 'launch-preflight':
      return 'client-selection';
    case 'token-refresh':
      return 'token-refresh';
    case 'identity-profile':
      return 'identity-preparation';
    case 'account-state-update':
      return 'account-finalize';
    default:
      return 'target-write';
  }
}

function diagnosticReasonFor(
  kind: CloudAccountSwitchErrorCode,
  reason: SwitchFailureReason,
  observed: CloudSwitchDiagnostic['reason'],
  error: unknown,
): CloudSwitchDiagnostic['reason'] {
  if (error instanceof CredentialReadbackError) {
    return 'credential-readback-mismatch';
  }
  if (kind === 'account-not-found') {
    return 'account-not-found';
  }
  if (kind === 'reauth-required') {
    return 'reauth-required';
  }
  if (reason === 'process_close_failed') {
    return 'process-close-failed';
  }
  if (reason === 'start_process_failed') {
    return 'process-start-failed';
  }
  return observed;
}

export function formatSwitchRefreshError(error: unknown): string {
  if (isRetryableInvalidGrantRefreshError(error)) {
    return 'Token refresh was rejected after confirmation. Retry later before reauthorizing the account.';
  }
  if (error instanceof CloudAccountRefreshBlockedError) {
    return 'Token refresh failed repeatedly. Please re-login and complete authorization.';
  }

  const reason = extractErrorMessage(error);
  const normalized = reason.toLowerCase();
  if (
    normalized.includes('unauthorized_client') ||
    normalized.includes('invalid_client') ||
    normalized.includes('invalid_grant')
  ) {
    return `Token refresh failed: OAuth client is not authorized for this account. Please re-login and complete authorization. Raw error: ${reason}`;
  }
  if (
    normalized.includes('verify your account') ||
    normalized.includes('further action is required') ||
    normalized.includes('validation required') ||
    normalized.includes('validation_url') ||
    normalized.includes('appeal_url')
  ) {
    return `Token refresh failed: account requires additional verification. Please finish verification and retry. Raw error: ${reason}`;
  }
  if (
    normalized.includes('resource_exhausted') ||
    normalized.includes('resource has been exhausted')
  ) {
    return `Token refresh failed: account is rate-limited or temporarily restricted (RESOURCE_EXHAUSTED). Please retry later. Raw error: ${reason}`;
  }
  return `Token refresh failed: ${reason}`;
}

export async function switchCloudAccountCore(
  accountId: string,
  appTarget?: AntigravityAppTarget,
  options: CloudAccountSwitchOptions = {},
): Promise<void> {
  const operation = new OperationContext('cloud-account-switch', options.diagnosticId);
  try {
    await operation.run(() =>
      runWithSwitchGuard(
        'cloud-account-switch',
        async () => {
          let failureCode: CloudAccountSwitchErrorCode = 'switch-failed';
          let stage: SwitchStage = 'account-lookup';
          let storage: ClientAccountStorage | null = null;
          let failureReason: SwitchFailureReason = 'unknown';
          let writeFailure: unknown;
          const setStage = (next: SwitchStage) => {
            stage = next;
            operation.observe(diagnosticStageFor(next, 'unknown'), 'started');
          };
          operation.observe('account-load', 'started');
          try {
            const account = await CloudAccountRepo.getAccount(accountId);
            if (!account) {
              throw new CloudAccountSwitchError('account-not-found');
            }

            const context = new CloudAccountSwitchContext(account);
            logger.info(`Switching to cloud account: ${account.email} (${account.id})`);
            setStage('launch-preflight');
            const launchContext =
              appTarget === 'agy'
                ? undefined
                : await prepareLaunchContext(appTarget === 'ide' ? 'ide' : 'classic');
            await withTimingTrace(
              'switch.cloud.prepare',
              {
                accountId: account.id,
                appTarget: appTarget || 'classic',
              },
              async (trace) => {
                await context.assertCurrent();
                setStage('identity-profile');
                trace.phaseSync('deviceProfileSetupMs', () => {
                  if (appTarget !== 'agy') {
                    ensureGlobalOriginalFromCurrentStorage(appTarget, launchContext?.pathOptions);
                  }

                  if (!account.device_profile) {
                    const guard = captureDeviceBindingWriteGuard(account);
                    const generated = generateDeviceProfile();
                    CloudAccountDeviceBindingStore.setDeviceBinding(
                      account.id,
                      generated,
                      'auto_generated',
                      guard,
                    );
                    saveGlobalOriginalProfile(generated);
                    account.device_profile = generated;
                    context.acceptOwnProfile();
                  }
                });

                setStage('token-refresh');
                const tokenRefreshPromise = (async () => {
                  const now = Math.floor(Date.now() / 1000);
                  if (
                    !isString(account.token.refresh_token) ||
                    isEmpty(account.token.refresh_token.trim())
                  ) {
                    logger.warn(
                      `Token for ${account.email} has no refresh token; switched IDE session may expire without recovery.`,
                    );
                    return;
                  }

                  logger.info(`Refreshing token for ${account.email} before IDE injection...`);
                  try {
                    const refreshedToken = await CloudAccountRefreshService.refreshAccessToken(
                      createCloudAccountRefreshRequest(account),
                    );

                    const updatedToken = mergeRefreshedToken(account.token, refreshedToken, now);
                    await context.updateToken(updatedToken);
                    logger.info(`Token refreshed for ${account.email}`);
                  } catch (error) {
                    logger.warn('Failed to refresh token before IDE injection', error);
                    if (error instanceof CloudAccountRefreshContextChangedError) {
                      throw error;
                    }
                    await context.assertCurrent(error);
                    await markAccountStatusFromError(account, error, context.guardFor(error));
                    if (error instanceof CloudAccountRefreshBlockedError) {
                      throw new CloudAccountSwitchError('reauth-required');
                    }
                    throw new Error(formatSwitchRefreshError(error), { cause: error });
                  }
                })();

                await trace.phase('tokenRefreshMs', async () => {
                  await tokenRefreshPromise;
                });

                setStage('enterprise-project');
                await trace.phase('enterpriseProjectReadyMs', async () => {
                  await ensureCloudSwitchProjectReady(account, context);
                });
              },
            );

            setStage('target-prepare');
            const preparedWrite = await prepareClientAccountWrite(
              {
                email: account.email,
                name: account.name || account.email,
                token: account.token,
                ...(process.platform === 'darwin' && account.device_profile
                  ? { serviceMachineId: account.device_profile.macMachineId }
                  : {}),
              },
              appTarget,
              launchContext?.pathOptions,
            );
            await context.assertCurrent();
            storage = preparedWrite.storage;
            setStage('switch-execution');
            await executeSwitchFlow({
              scope: 'cloud',
              accountEmail: account.email,
              appTarget,
              targetProfile: account.device_profile || null,
              applyFingerprint:
                process.platform === 'darwin'
                  ? Boolean(account.device_profile)
                  : isIdentityProfileApplyEnabled(),
              useCredentialStore: preparedWrite.storage === 'credential-store',
              processExitTimeoutMs: process.platform === 'darwin' ? 20000 : 10000,
              launchContext,
              assertCurrent: context.assertCurrent,
              onFailure: (reason) => {
                failureCode = publicFailureCode(reason);
                failureReason = reason;
              },
              onDiagnosticStage: (next) => operation.observe(next, 'started'),
              onSwitchTrace: (trace) => operation.setSwitchTrace(trace),
              performSwitch: async () => {
                try {
                  await context.assertCurrent();
                  await preparedWrite.write();
                  await context.assertCurrent();
                  writeFailure = undefined;
                } catch (error) {
                  writeFailure = error;
                  throw error;
                }
              },
              afterSwitchSuccess: async () => {
                setStage('account-state-update');
                CloudAccountRepo.finalizeSwitch(account.id, appTarget, context.guard);
                await context.assertCurrent();
                account.status = 'active';
                account.status_reason = undefined;

                logger.info(`Successfully switched to cloud account: ${account.email}`);
                accountOwnerEvents.publish({
                  kind: 'account-switched',
                  accountId: account.id,
                  target: appTarget ?? 'classic',
                  reason: options.presentationReason ?? 'manual',
                });
                try {
                  await options.onSuccess?.(account);
                } catch {
                  logger.warn('Account switch presentation effect failed');
                }
              },
            });
            operation.completeSwitch();
          } catch (error) {
            logger.warn('Cloud account switch stopped before completion', error);
            const kind = error instanceof CloudAccountSwitchError ? error.switchCode : failureCode;
            const primaryError =
              kind === 'target-write-failed' && writeFailure && !(error instanceof AggregateError)
                ? writeFailure
                : error;
            const classified = classifyOperationCause(error);
            const diagnosticStage = diagnosticStageFor(stage, failureReason, primaryError);
            const reason = diagnosticReasonFor(
              kind,
              failureReason,
              classified.primary.reason,
              primaryError,
            );
            const diagnostic = CloudSwitchDiagnosticSchema.parse(
              operation.finish(
                {
                  stage: diagnosticStage,
                  ...classified.primary,
                  reason,
                  target: appTarget ?? 'classic',
                  ...(storage ? { storage } : {}),
                  rollback: 'not-attempted',
                  causes: classified.causes,
                  ...(classified.causesTruncated ? { causesTruncated: true } : {}),
                  ...(primaryError instanceof CredentialReadbackError
                    ? { readback: primaryError.matches }
                    : {}),
                },
                false,
                classified.sourceLocations,
              ),
            );
            throw new CloudAccountSwitchError(kind, diagnostic);
          }
        },
        appTarget,
      ),
    );
  } catch (error) {
    if (error instanceof CloudAccountSwitchError && error.diagnostic) {
      throw error;
    }
    const classified = classifyOperationCause(error);
    const diagnostic = CloudSwitchDiagnosticSchema.parse(
      operation.finish(
        {
          stage: 'management-transport',
          ...classified.primary,
          reason:
            error instanceof AppError && error.messageKey === 'process-runtime.busy'
              ? 'locked'
              : classified.primary.reason,
          target: appTarget ?? 'classic',
          rollback: 'not-attempted',
          causes: classified.causes,
          ...(classified.causesTruncated ? { causesTruncated: true } : {}),
        },
        error instanceof AppError && !error.reportToSentry,
        classified.sourceLocations,
      ),
    );
    throw new CloudAccountSwitchError('switch-failed', diagnostic);
  }
}
