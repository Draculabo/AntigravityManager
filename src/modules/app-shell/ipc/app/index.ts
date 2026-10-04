import { appVersion, bugReportEnvironment, currentPlatfom } from './handlers';
import { os } from '@orpc/server';

export const app = os.router({
  currentPlatfom,
  appVersion,
  bugReportEnvironment,
});
