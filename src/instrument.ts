import { app } from 'electron';
import * as Sentry from '@sentry/electron/main';
import path from 'path';
import fs from 'fs';
import { getAppDataDir } from './utils/paths';
import { logger } from './utils/logger';

function getQuickConfig() {
  try {
    const configPath = path.join(getAppDataDir(), 'gui_config.json');
    if (fs.existsSync(configPath)) {
      const content = fs.readFileSync(configPath, 'utf-8');
      const config = JSON.parse(content);
      // Default to false (privacy by default)
      return config.error_reporting_enabled;
    }
  } catch (e) {
    logger.error('Failed to read config for Sentry init:', e);
  }
  return false;
}

if (getQuickConfig()) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    release: `antigravity-manager@${app.getVersion()}`,
    beforeSend(event) {
      if (event.exception?.values?.[0]?.value) {
        event.exception.values[0].value = event.exception.values[0].value.replace(
          /Users\\\\[^\\\\]+/g,
          'Users\\\\***',
        );
      }
      return event;
    },
  });
  logger.setErrorReportingEnabled(true);
  logger.setSentryReporter((payload) => {
    Sentry.withScope((scope) => {
      scope.setTag('log_level', payload.level);
      scope.setContext('recent_logs', {
        entries: payload.logs.map((entry) => ({
          timestamp: new Date(entry.timestamp).toISOString(),
          level: entry.level,
          message: entry.message,
          formatted: entry.formatted,
        })),
      });
      scope.setExtra('log_message', payload.message);
      if (payload.error) {
        Sentry.captureException(payload.error);
        return;
      }
      Sentry.captureMessage(payload.message, 'error');
    });
  });
} else {
  logger.setErrorReportingEnabled(false);
  logger.setSentryReporter(null);
}
