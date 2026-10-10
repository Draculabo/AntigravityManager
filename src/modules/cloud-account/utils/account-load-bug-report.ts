import type { BugReportEnvironment } from '@/modules/app-shell/bug-report-environment';
import { getErrorDetailsText } from '@/shared/utils/errorMessages';
import { buildErrorBugReport } from '@/modules/app-shell/bug-report';

export { BUG_REPORT_URL } from '@/modules/app-shell/bug-report';

export function buildAccountLoadBugReport(
  environment: BugReportEnvironment,
  error: unknown,
): string {
  return buildErrorBugReport(
    environment,
    getErrorDetailsText(error),
    'Cloud accounts could not be loaded. Error details:',
  );
}
