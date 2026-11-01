import { isFailedAuditAttempt } from '../audit/audit-attempt-outcome';
import { auditJsonObject } from '../audit/audit-json-object';
import type { TrafficAuditDetail } from '../audit/traffic-audit.types';

type Attempts = Extract<TrafficAuditDetail, { recordKind: 'request' }>['attempts'];

export function getFallbackDiagnosticsSummary(
  attempts: Attempts,
  t: (
    key: string,
    options: { index: number; operation: string; status: string; error?: string },
  ) => string,
): string {
  const parts: string[] = [];
  const failed = attempts.filter(isFailedAuditAttempt);
  if (failed.length === 0) {
    return '';
  }
  for (const attempt of failed) {
    let error = attempt.error ?? '';
    try {
      const parsed = auditJsonObject(JSON.parse(error));
      if (typeof parsed?.message === 'string') {
        error = parsed.message;
      }
    } catch {
      // Non-JSON audit errors remain readable as their original text.
    }
    const status = attempt.status ? ` (HTTP ${attempt.status})` : '';
    const operation = attempt.operation ? `[${attempt.operation}] ` : '';
    const message = error ? `: ${error.slice(0, 120)}` : '';
    parts.push(
      t('traffic.fallback-attempt-failed', {
        index: attempt.attemptIndex,
        operation,
        status,
        error: message,
      }),
    );
  }
  // A successful preparation call before a failed generation is not its recovery.
  const lastFailureIndex = Math.max(...failed.map((attempt) => attempt.attemptIndex));
  const completed = attempts.findLast(
    (attempt) =>
      attempt.attemptIndex > lastFailureIndex &&
      attempt.outcome === 'completed' &&
      attempt.status !== null &&
      attempt.status >= 200 &&
      attempt.status < 300,
  );
  if (completed) {
    parts.push(
      t('traffic.fallback-attempt-recovered', {
        index: completed.attemptIndex,
        operation: completed.operation ? `[${completed.operation}] ` : '',
        status: completed.status ? `(HTTP ${completed.status})` : '',
      }),
    );
  }
  return parts.join('; ');
}
