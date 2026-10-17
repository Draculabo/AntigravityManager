import type { BugReportEnvironment } from './bug-report-environment';
import { redactDiagnosticText } from '@/shared/observability/sentryPrivacy';
import bugReportTemplate from '../../../.github/ISSUE_TEMPLATE/bug_report.md?raw';

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
    .map((line) => (line ? `    ${line}` : ''))
    .join('\n');
  const template = bugReportTemplate.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '').trim();
  const sections = template.replaceAll('\r\n', '\n').split(/\n(?=## )/);
  return sections
    .map((section) => {
      if (section.startsWith('## Screenshots or Diagnostic Details\n')) {
        return `${section.trim()}\n\n${errorBlock}\n`;
      }
      if (section.startsWith('## Environment\n')) {
        return section
          .replace('- **App version**:', `- **App version**: ${environment.appVersion}`)
          .replace(
            '- **Operating system and version**:',
            `- **Operating system and version**: ${environment.platform} — ${environment.osVersion}`,
          )
          .replace(
            /- \*\*CPU architecture\*\*:.*/,
            `- **CPU architecture**: ${environment.architecture}`,
          )
          .replace(
            '### Source Development Only',
            `- **Electron version**: ${environment.electronVersion}\n- **Bundled Node.js version**: ${environment.nodeVersion}\n\n### Source Development Only`,
          );
      }
      if (section.startsWith('## Additional Context\n')) {
        return `${section.trim()}\n\n${redactDiagnosticText(summary)}\n`;
      }
      return section;
    })
    .join('\n');
}
