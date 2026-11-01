import type { AuditOutcome } from './traffic-audit.types';

/** Successful preparation calls and unfinished writes do not establish a fallback. */
export function isFailedAuditAttempt(attempt: {
  outcome: AuditOutcome;
  status?: number | null;
}): boolean {
  return (
    (attempt.outcome !== 'completed' && attempt.outcome !== 'in_progress') ||
    (attempt.status !== undefined && attempt.status !== null && attempt.status >= 400)
  );
}
