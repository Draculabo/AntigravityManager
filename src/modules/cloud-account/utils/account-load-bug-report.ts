import type { BugReportEnvironment } from '@/modules/app-shell/bug-report-environment';
import { redactLocalUserPaths } from '@/shared/observability/sentryPrivacy';
import { getErrorDetailsText } from '@/shared/utils/errorMessages';

export const BUG_REPORT_URL =
  'https://github.com/Draculabo/AntigravityManager/issues/new?template=bug_report.md';

/** Error text can contain provider credentials even when no account object is included. */
function redactReportDetails(text: string): string {
  return redactLocalUserPaths(text)
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/-]+=*/gi, '$1 [REDACTED]')
    .replace(
      /([?&](?:access_token|refresh_token|id_token|api_key|key|client_secret|code)=)[^&#\s]*/gi,
      '$1[REDACTED]',
    )
    .replace(
      /(["']?\b(?:token|access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key|x-api-key|x-goog-api-key|client[_-]?secret|password|authorization|cookie|session[_-]?id|auth[_-]?code|secret)["']?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s&,;]+)/gi,
      '$1[REDACTED]',
    )
    .replace(/\b((?:https?|socks5?):\/\/)[^/\s]*@/gi, '$1[REDACTED]@')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[EMAIL REDACTED]');
}

export function buildAccountLoadBugReport(
  environment: BugReportEnvironment,
  error: unknown,
): string {
  const details = redactReportDetails(getErrorDetailsText(error));
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
