import { randomUUID } from 'node:crypto';
import { getSwitchMetricsSnapshot } from '@/modules/antigravity-runtime/switch/switchMetrics';
import { getSwitchGuardSnapshot } from '@/modules/antigravity-runtime/switch/switchGuard';
import { getDeviceHardeningSnapshot } from '@/modules/identity-profile/ipc/handler';
import {
  CloudAccountSwitchStatusSchema,
  DeviceFailureStageSchema,
  type CloudAccountSwitchStatus,
} from './cloud-account-switch-status.schema';

const epoch = randomUUID();

/** Metrics, guards and hardening are volatile state of the process performing switches. */
export function getCloudAccountSwitchStatus(): CloudAccountSwitchStatus {
  const metrics = getSwitchMetricsSnapshot();
  const guard = getSwitchGuardSnapshot();
  const hardening = getDeviceHardeningSnapshot();
  const projectBucket = (bucket: typeof metrics.cloud) => ({
    switchSuccess: bucket.switchSuccess,
    switchFailure: bucket.switchFailure,
    rollbackAttempt: bucket.rollbackAttempt,
    rollbackSuccess: bucket.rollbackSuccess,
    rollbackFailure: bucket.rollbackFailure,
    failureReasons: bucket.failureReasons,
    lastFailure: bucket.lastFailure
      ? {
          reason: bucket.lastFailure.reason,
          message: 'Account switch failed.' as const,
          occurredAt: bucket.lastFailure.occurredAt,
        }
      : null,
  });
  const stage = DeviceFailureStageSchema.safeParse(hardening.lastFailureStage);
  return CloudAccountSwitchStatusSchema.parse({
    provenance: 'account-owner-process',
    epoch,
    metrics: { local: projectBucket(metrics.local), cloud: projectBucket(metrics.cloud) },
    guard,
    hardening: {
      ...hardening,
      lastFailureStage:
        hardening.lastFailureStage === null ? null : stage.success ? stage.data : 'unknown',
    },
  });
}
