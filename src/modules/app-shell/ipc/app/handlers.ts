import { os } from '@orpc/server';
import { app } from 'electron';
import { release, version } from 'node:os';
import { BugReportEnvironmentSchema } from '../../bug-report-environment';

export const currentPlatfom = os.handler(() => {
  return process.platform;
});

export const appVersion = os.handler(() => {
  return app.getVersion();
});

export const bugReportEnvironment = os.output(BugReportEnvironmentSchema).handler(() => ({
  appVersion: app.getVersion(),
  platform: process.platform,
  osVersion: `${version()} (${release()})`,
  architecture: process.arch,
  electronVersion: process.versions.electron ?? 'Unavailable',
  nodeVersion: process.versions.node,
}));
