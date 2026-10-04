import { z } from 'zod';

const CounterSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const SwitchOwnerSchema = z.enum(['local-account-switch', 'cloud-account-switch']);
const SwitchFailureReasonSchema = z.enum([
  'unknown',
  'process_close_failed',
  'missing_bound_profile',
  'apply_device_profile_failed',
  'perform_switch_failed',
  'start_process_failed',
]);
export const DeviceFailureStageSchema = z.enum([
  'unknown',
  'prepare_backup',
  'prepare_write_storage',
  'prepare_sync_state',
  'verify_storage',
  'verify_state',
  'commit_snapshot',
  'rollback',
  'rollback_immediate_backup',
  'rollback_last_known_good',
]);
const MetricBucketSchema = z.strictObject({
  switchSuccess: CounterSchema,
  switchFailure: CounterSchema,
  rollbackAttempt: CounterSchema,
  rollbackSuccess: CounterSchema,
  rollbackFailure: CounterSchema,
  failureReasons: z.strictObject({
    unknown: CounterSchema,
    process_close_failed: CounterSchema,
    missing_bound_profile: CounterSchema,
    apply_device_profile_failed: CounterSchema,
    perform_switch_failed: CounterSchema,
    start_process_failed: CounterSchema,
  }),
  lastFailure: z
    .strictObject({
      reason: SwitchFailureReasonSchema,
      message: z.literal('Account switch failed.'),
      occurredAt: CounterSchema,
    })
    .nullable(),
});

export const CloudAccountSwitchStatusSchema = z.strictObject({
  provenance: z.literal('account-owner-process'),
  epoch: z.uuid(),
  metrics: z.strictObject({ local: MetricBucketSchema, cloud: MetricBucketSchema }),
  guard: z.strictObject({
    activeOwner: SwitchOwnerSchema.nullable(),
  }),
  hardening: z.strictObject({
    consecutiveApplyFailures: CounterSchema,
    safeModeActive: z.boolean(),
    safeModeUntil: CounterSchema.nullable(),
    lastFailureReason: z
      .enum([
        'backup_failed',
        'storage_write_failed',
        'state_sync_failed',
        'verify_storage_failed',
        'verify_state_failed',
        'snapshot_update_failed',
        'rollback_failed',
        'unknown',
      ])
      .nullable(),
    lastFailureStage: DeviceFailureStageSchema.nullable(),
    lastFailureAt: CounterSchema.nullable(),
  }),
});
export type CloudAccountSwitchStatus = z.infer<typeof CloudAccountSwitchStatusSchema>;
