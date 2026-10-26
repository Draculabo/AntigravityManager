import { getTrafficAuditRequestContext } from '../../audit/traffic-audit-context';

export type PromptTransformationKind =
  | 'billing-metadata-removed'
  | 'identity-normalized'
  | 'initial-system-promoted'
  | 'late-system-reminder'
  | 'global-system-prepended'
  | 'empty-text-removed'
  | 'prefill-tail-appended'
  | 'thought-signature-wrapped';

export interface PromptTransformation {
  kind: PromptTransformationKind;
  surface: 'system' | 'messages' | 'contents';
  message: number | null;
  part: number | null;
}

export interface PromptTransformationState {
  entries: PromptTransformation[];
  dropped: number;
}

/** Request-local metadata only. No prompt, argument, signature or arbitrary label is retained. */
export function recordPromptTransformation(entry: PromptTransformation): void {
  const context = getTrafficAuditRequestContext();
  if (!context) {
    return;
  }
  const state = (context.promptTransformations ??= { entries: [], dropped: 0 });
  if (state.entries.length < 64) {
    state.entries.push({ ...entry });
  } else {
    state.dropped++;
  }
}

export function snapshotPromptTransformations(): PromptTransformationState {
  const state = getTrafficAuditRequestContext()?.promptTransformations;
  return {
    entries: state?.entries.map((entry) => ({ ...entry })) ?? [],
    dropped: state?.dropped ?? 0,
  };
}
