import type { BugReportEnvironment } from './bug-report-environment';
import { redactDiagnosticText } from '@/shared/observability/sentryPrivacy';

export const BUG_REPORT_URL =
  'https://github.com/Draculabo/AntigravityManager/issues/new?template=bug_report.md';

/** Keep report text out of the URL; users review, paste and submit it themselves. */
export function buildErrorBugReport(
  environment: BugReportEnvironment,
  details: string,
  summary = 'An operation failed. Error details:',
): string {
  const errorBlock = redactDiagnosticText(details)
    .split('\n')
    .map((line) => `    ${line}`)
    .join('\n');
  return [
    '## Environment',
    '',
    `- **OS**: ${environment.platform} — ${environment.osVersion}`,
    `- **Architecture**: ${environment.architecture}`,
    `- **App Version**: ${environment.appVersion}`,
    `- **Electron Version**: ${environment.electronVersion}`,
    `- **Node.js Version**: ${environment.nodeVersion}`,
    '',
    '## Additional Context',
    '',
    summary,
    '',
    errorBlock,
  ].join('\n');
}
