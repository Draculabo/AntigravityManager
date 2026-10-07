import { appVersion, bugReportEnvironment, currentPlatfom } from './handlers';
import { os } from '@orpc/server';
import { openReleaseNotesLink, releaseNotes } from './releaseNotes';

export const app = os.router({
  currentPlatfom,
  appVersion,
  bugReportEnvironment,
  releaseNotes,
  openReleaseNotesLink,
});
