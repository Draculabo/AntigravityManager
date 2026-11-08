import {
  getTrafficAuditRequestContext,
  type TrafficAuditRequestContext,
} from '../audit/traffic-audit-context';

/** Counts operations in one request, including repeated preparation during existing retries. */
export interface ThoughtRestoreDiagnostics {
  signatureCacheHits: number;
  signatureCacheMisses: number;
  memoryHits: number;
  coldHits: number;
  restoredSourceUnknown: number;
  noCandidate: number;
  unresolved: number;
  matchedUnchanged: number;
  admissionUnavailable: number;
  readUnavailable: number;
  cooldownUnavailable: number;
  cancelled: number;
  invalidated: number;
}

export type ThoughtRestoreUnavailable =
  | 'admissionUnavailable'
  | 'readUnavailable'
  | 'cooldownUnavailable';

export function recordThoughtRestoreOutcome(kind: keyof ThoughtRestoreDiagnostics): void {
  const context = getTrafficAuditRequestContext();
  if (!context) {
    return;
  }
  const state = (context.thoughtRestore ??= {
    signatureCacheHits: 0,
    signatureCacheMisses: 0,
    memoryHits: 0,
    coldHits: 0,
    restoredSourceUnknown: 0,
    noCandidate: 0,
    unresolved: 0,
    matchedUnchanged: 0,
    admissionUnavailable: 0,
    readUnavailable: 0,
    cooldownUnavailable: 0,
    cancelled: 0,
    invalidated: 0,
  });
  state[kind] += 1;
}

/** Fixed counters only; no history, signature, tool identity or provider error is retained. */
export function snapshotThoughtRestoreDiagnostics(
  context: TrafficAuditRequestContext | undefined = getTrafficAuditRequestContext(),
): ThoughtRestoreDiagnostics | null {
  return context?.thoughtRestore ? { ...context.thoughtRestore } : null;
}
