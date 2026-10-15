import type { OperationDiagnostic } from './operationDiagnostic';

/** Plain support references; an SDK receipt deliberately makes no delivery assertion. */
export function formatOperationDiagnostic(diagnostic: OperationDiagnostic): string {
  const lines = [
    `Diagnostic ID: ${diagnostic.diagnosticId}`,
    `Operation: ${diagnostic.operation}`,
    `Stage: ${diagnostic.stage}`,
    `Reason: ${diagnostic.reason}`,
  ];
  if (diagnostic.upstreamStatus !== undefined) {
    lines.push(`Upstream HTTP status: ${diagnostic.upstreamStatus}`);
  }
  if (diagnostic.upstreamCode) {
    lines.push(`Upstream code: ${diagnostic.upstreamCode}`);
  }
  if (diagnostic.http) {
    lines.push(`HTTP connection evidence: ${JSON.stringify(diagnostic.http)}`);
  }
  if (diagnostic.nativeCode) {
    lines.push(`Native code: ${diagnostic.nativeCode}`);
  }
  if (diagnostic.accountCommit) {
    lines.push(`Account persistence: ${diagnostic.accountCommit}`);
  }
  if (diagnostic.target) {
    lines.push(`Target: ${diagnostic.target}`);
  }
  if (diagnostic.storage) {
    lines.push(`Storage: ${diagnostic.storage}`);
  }
  if (diagnostic.rollback) {
    lines.push(`Rollback: ${diagnostic.rollback}`);
  }
  if (diagnostic.readback) {
    lines.push(`Credential field matches: ${JSON.stringify(diagnostic.readback)}`);
  }
  if (diagnostic.causes?.length) {
    lines.push(`Classified causes: ${JSON.stringify(diagnostic.causes)}`);
  }
  if (diagnostic.causesTruncated) {
    lines.push('Additional causes omitted');
  }
  switch (diagnostic.reporting.state) {
    case 'captured':
      lines.push(
        `Sentry event ID: ${diagnostic.reporting.eventId}`,
        'Reporting: captured by SDK; delivery not confirmed',
      );
      break;
    case 'not-reported':
      lines.push(`Reporting: not reported (${diagnostic.reporting.reason})`);
      break;
    case 'failed':
      lines.push('Reporting: SDK dispatch failed');
      break;
  }
  return lines.join('\n');
}
