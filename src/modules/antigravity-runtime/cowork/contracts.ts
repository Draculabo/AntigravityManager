import { z } from 'zod';

export const CoworkSelectionInput = z.object({ selectionId: z.uuid() });
export const CoworkOperationInput = CoworkSelectionInput.extend({
  previewId: z.uuid(),
  restart: z.boolean(),
});
export const CoworkLifecycleInput = CoworkSelectionInput.extend({
  action: z.enum(['inspect', 'stop', 'start']),
});
export const CoworkDiscoveryInput = z.object({
  customPath: z.string().trim().min(1).max(4096).optional(),
});

export const CoworkCandidateSchema = z.object({
  path: z.string(),
  canonicalPath: z.string(),
  source: z.enum(['discovered', 'custom']),
  version: z.string().nullable(),
  bytes: z.number().int().nonnegative(),
  sha256: z.string().nullable(),
});
export const CoworkPatchStateSchema = z.enum([
  'original', 'legacy-return0', 'legacy-35k', 'current-8k',
  'unsupported', 'ambiguous', 'unreadable',
]);
export const CoworkEligibilitySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('eligible'), packageId: z.string(), version: z.string() }),
  z.object({
    kind: z.literal('unsupported'),
    code: z.enum([
      'windows-recipe-unverified', 'native-payload-unverified',
      'bundle-recovery-unverified', 'package-ownership-unverified',
    ]),
  }),
]);
export const CoworkTargetSchema = z.object({
  selectionId: z.uuid(),
  candidate: CoworkCandidateSchema,
  state: CoworkPatchStateSchema,
  matchedFunctions: z.number().int().nonnegative(),
  nativePayload: z.object({
    kind: z.literal('bun-macho-arm64'),
    start: z.number().int().nonnegative(),
    end: z.number().int().positive(),
    graph: z.object({
      moduleCount: z.number().int().positive(),
      entryPoint: z.object({
        name: z.string().min(1),
        start: z.number().int().nonnegative(),
        end: z.number().int().positive(),
      }),
    }).optional(),
  }).optional(),
  eligibility: CoworkEligibilitySchema,
  recovery: z.enum(['not-inspected', 'none', 'available', 'interrupted']),
}).refine(({ nativePayload, candidate, state, eligibility }) => (
  !nativePayload || (
    nativePayload.start < nativePayload.end &&
    nativePayload.end <= candidate.bytes &&
    (!nativePayload.graph || (
      nativePayload.graph.entryPoint.start >= nativePayload.start &&
      nativePayload.graph.entryPoint.start < nativePayload.graph.entryPoint.end &&
      nativePayload.graph.entryPoint.end < nativePayload.end
    )) &&
    state === 'unsupported' &&
    eligibility.kind === 'unsupported'
  )
), { path: ['nativePayload'] });
export const CoworkFailureCodeSchema = z.enum([
  'selection-expired', 'stale-target', 'unsupported-target', 'unavailable-preview',
  'busy', 'process-state-unknown', 'stop-failed', 'write-failed',
  'verification-failed', 'backup-invalid', 'recovery-required', 'lifecycle-failed',
]);
export const CoworkReceiptSchema = z.object({
  operationId: z.uuid(),
  action: z.enum(['apply', 'restore']),
  outcome: z.enum(['applied', 'restored', 'already-current', 'failed']),
  effect: z.enum(['none', 'committed', 'rolled-back', 'uncertain']),
  code: CoworkFailureCodeSchema.nullable(),
  recovery: z.enum(['not-needed', 'verified', 'failed']),
  recoveryCode: CoworkFailureCodeSchema.nullable(),
  backupId: z.string().nullable(),
  recoveryLocation: z.string().nullable(),
  restart: z.enum(['not-requested', 'not-attempted', 'verified', 'failed']),
});
export const CoworkPreviewSchema = z.object({
  selectionId: z.uuid(),
  previewId: z.uuid().nullable(),
  action: z.enum(['apply', 'restore']),
  state: z.enum(['ready', 'inspection-only', 'already-current', 'unavailable']),
  target: CoworkTargetSchema,
  beforeSha256: z.string().nullable(),
  afterSha256: z.string().nullable(),
  byteRange: z.object({ start: z.number(), end: z.number() }).nullable(),
  backupId: z.string().nullable(),
  signature: z.enum(['not-required', 'unsupported']),
  lifecycle: z.enum(['selected-instance', 'unsupported']),
});
export const CoworkLifecycleResultSchema = z.object({
  selectionId: z.uuid(),
  state: z.enum(['running', 'stopped', 'unknown', 'unsupported']),
  code: CoworkFailureCodeSchema.nullable(),
});
export const CoworkJournalSchema = z.object({
  format: z.literal(1),
  targetPath: z.string(),
  packageId: z.string(),
  version: z.string(),
  originalSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  patchedSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  mode: z.number().int().nonnegative(),
  phase: z.enum(['prepared', 'committing', 'committed', 'restoring', 'restored', 'rolled-back', 'recovery-required']),
});
export type CoworkTarget = z.infer<typeof CoworkTargetSchema>;
export type CoworkPreview = z.infer<typeof CoworkPreviewSchema>;
export type CoworkReceipt = z.infer<typeof CoworkReceiptSchema>;
export type CoworkFailureCode = z.infer<typeof CoworkFailureCodeSchema>;
export type CoworkJournal = z.infer<typeof CoworkJournalSchema>;
export type CoworkLifecycleResult = z.infer<typeof CoworkLifecycleResultSchema>;

export class CoworkOperationError extends Error {
  constructor(readonly code: CoworkFailureCode, options?: ErrorOptions) {
    super(code, options);
    this.name = 'CoworkOperationError';
  }
}

/** Only a main-process package adapter can grant this capability, never renderer input. */
export interface VerifiedCoworkSource {
  kind: 'verified-standalone-source';
  canonicalPath: string;
  packageId: string;
  version: string;
  signature: 'not-required';
  verifyOwnership: () => Promise<void>;
  lifecycle: {
    inspect: () => Promise<'running' | 'stopped' | 'unknown'>;
    stop: () => Promise<void>;
    start: () => Promise<void>;
  };
}
