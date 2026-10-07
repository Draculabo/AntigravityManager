import type { BugReportEnvironment } from '@/modules/app-shell/bug-report-environment';
import { redactDiagnosticText } from '@/shared/observability/sentryPrivacy';
import { getErrorDetailsText } from '@/shared/utils/errorMessages';

export const BUG_REPORT_URL =
  'https://github.com/Draculabo/AntigravityManager/issues/new?template=bug_report.md';

export function buildAccountLoadBugReport(
  environment: BugReportEnvironment,
  error: unknown,
): string {
  const details = redactDiagnosticText(getErrorDetailsText(error));
  // Indentation keeps arbitrary stack text inside a Markdown code block.
  const errorBlock = details
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
    'Cloud accounts could not be loaded. Error details:',
    '',
    errorBlock,
  ].join('\n');
}
