import { z } from 'zod';
import { ProcessDiagnosticSchema } from './processDiagnostic';

export const SwitchStageSchema = z.enum([
  'hot-prepare',
  'hot-write',
  'service-stop',
  'credential-reassert',
  'service-replacement',
  'restart-ownership',
  'client-close',
  'restart-write',
  'terms-restore',
  'client-start',
  'account-finalize',
  'terms-capture',
  'terms-rollback',
  'terms-confirm',
]);
export type SwitchStage = z.infer<typeof SwitchStageSchema>;
// Logical owners survive packaged builds without source-map frames.
export const SWITCH_STAGE_OWNERS = {
  'hot-prepare': 'prepareClassicHotSwitch',
  'hot-write': 'writeSwitchState',
  'service-stop': 'ClassicHotSwitchSession.stopServices',
  'credential-reassert': 'writeSwitchState',
  'service-replacement': 'ClassicHotSwitchSession.confirmReplacement',
  'restart-ownership': 'assertClassicRestartOwnership',
  'client-close': 'stopFromContext',
  'restart-write': 'writeSwitchState',
  'terms-restore': 'ClassicTermsSwitch.apply',
  'client-start': 'startFromContext',
  'account-finalize': 'afterSwitchSuccess',
  'terms-capture': 'ClassicTermsSwitch.captureForHotSwitch',
  'terms-rollback': 'ClassicTermsSwitch.rollback',
  'terms-confirm': 'ClassicTermsSwitch.confirmHotSwitch',
} as const satisfies Record<SwitchStage, string>;
export const SwitchErrorSchema = z.strictObject({
  kind: z.enum(['process', 'credential-readback', 'native', 'unknown']),
  code: z
    .enum([
      'EACCES',
      'EPERM',
      'ENOENT',
      'EIO',
      'ENOSPC',
      'ETIMEDOUT',
      'SQLITE_BUSY',
      'SQLITE_LOCKED',
      'SQLITE_READONLY',
      'SQLITE_CANTOPEN',
    ])
    .optional(),
  process: ProcessDiagnosticSchema.optional(),
});
export const SwitchSourceSchema = z.strictObject({
  filename: z.enum([
    'src/modules/antigravity-runtime/classicHotSwitch.ts',
    'src/modules/antigravity-runtime/switch/classicSwitch.ts',
    'src/modules/antigravity-runtime/switch/switchFlow.ts',
    'src/modules/identity-profile/ipc/handler.ts',
    'src/modules/cloud-account/services/cloud-account-switch.service.ts',
    'src/modules/account/services/local-account-state.service.ts',
    'src/modules/antigravity-runtime/credentials/clientAccountWrite.ts',
    'src/modules/antigravity-runtime/credentials/antigravityCredentialStore.ts',
    'src/modules/antigravity-runtime/credentials/windowsCredentialStore.ts',
    'src/modules/antigravity-runtime/stop.ts',
    'src/modules/antigravity-runtime/stopWindowsClientForSwitch.ts',
    'src/modules/antigravity-runtime/launch.ts',
    'src/modules/antigravity-runtime/launchContext.ts',
    'src/modules/antigravity-runtime/processErrors.ts',
    'src/modules/antigravity-runtime/terms/classicTermsSwitch.ts',
  ]),
  lineno: z.number().int().min(1).max(1_000_000),
  colno: z.number().int().min(1).max(1_000_000),
});
export const SwitchStepSchema = z.strictObject({
  stage: SwitchStageSchema,
  owner: z.enum(Object.values(SWITCH_STAGE_OWNERS)),
  mode: z.enum(['hot', 'restart']),
  outcome: z.enum(['started', 'succeeded', 'failed']),
  elapsedMs: z.number().int().min(0).max(86_400_000),
  continuation: z.enum(['continue', 'restart', 'stop']),
  effects: z.strictObject({
    credentials: z.enum(['not-attempted', 'uncertain', 'confirmed']),
    services: z.enum(['untouched', 'uncertain', 'retired', 'replaced']),
    client: z.enum(['original', 'exit-uncertain', 'stopped', 'startup-uncertain', 'started']),
  }),
  errors: z.array(SwitchErrorSchema).max(8).optional(),
  sources: z.array(SwitchSourceSchema).max(8).optional(),
  detailsTruncated: z.boolean().optional(),
});
export const SwitchTraceSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    diagnosticId: z.uuid(),
    target: z.literal('classic'),
    outcome: z.enum(['hot-success', 'restart-success', 'recovered-by-restart', 'failed']),
    steps: z.array(SwitchStepSchema).max(32),
  })
  .refine((value) => new TextEncoder().encode(JSON.stringify(value)).length <= 48 * 1024);
export type SwitchTrace = z.infer<typeof SwitchTraceSchema>;
export type SwitchStep = z.infer<typeof SwitchStepSchema>;
