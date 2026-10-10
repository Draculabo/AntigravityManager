import { appVersion, bugReportEnvironment, currentPlatfom } from './handlers';
import { os } from '@orpc/server';
import { openReleaseNotesLink, releaseNotes } from './releaseNotes';
import { diagnosticLogsRouter } from '../../diagnostic-logs/desktop-router';

export const app = os.router({
  currentPlatfom,
  appVersion,
  bugReportEnvironment,
  diagnosticLogs: diagnosticLogsRouter,
  releaseNotes,
  openReleaseNotesLink,
});
