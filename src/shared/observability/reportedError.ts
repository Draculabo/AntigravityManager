import { redactDiagnosticText } from './sentryPrivacy';

/** Retain the diagnostic stack without exporting arbitrary provider error properties. */
export function sanitizeReportedError(source: Error): Error {
  const safe = new Error(redactDiagnosticText(source.message));
  safe.name = redactDiagnosticText(source.name);
  safe.stack = source.stack ? redactDiagnosticText(source.stack) : undefined;
  return safe;
}
