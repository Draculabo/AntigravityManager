import { app } from 'electron';
import path from 'node:path';
import * as Sentry from '@sentry/electron/main';
import {
  configureErrorReportingRuntime,
  flushErrorReporting,
} from './shared/observability/errorReporting';
import { isolateSentryDiagnostic } from './shared/observability/sentryDiagnostic';
import { logger } from './shared/logging/logger';
import {
  initializeOpenTelemetry,
  shutdownOpenTelemetry,
} from './shared/observability/openTelemetry';
import { getQuickObservabilityConfig } from './shared/observability/observabilityConfig';
import { filterCrashSafeSentryIntegrations } from './shared/observability/sentryIntegrations';
import {
  redactDiagnosticText,
  redactSentryEventLocalPaths,
} from './shared/observability/sentryPrivacy';

const quickConfig = getQuickObservabilityConfig(
  (message, error) => {
    logger.error(message, error);
  },
  path.join(app.getPath('userData'), 'desktop-preferences.json'),
);

initializeOpenTelemetry({
  enabled: quickConfig.telemetryEnabled,
  serviceVersion: app.getVersion(),
});

app.on('before-quit', () => {
  flushErrorReporting();
  shutdownOpenTelemetry().catch((error) => {
    logger.warn('Failed to flush OpenTelemetry before quit', error);
  });
});

configureErrorReportingRuntime(
  {
    initialize: () => {
      Sentry.init({
        dsn: process.env.SENTRY_DSN,
        release: `antigravity-manager@${app.getVersion()}`,
        integrations(defaultIntegrations) {
          return filterCrashSafeSentryIntegrations(defaultIntegrations);
        },
        beforeSend(event) {
          isolateSentryDiagnostic(event);
          redactSentryEventLocalPaths(event);
          return event;
        },
      });
    },
    report: (payload) => {
      Sentry.withScope((scope) => {
        scope.setTag('runtime', 'desktop-embedded');
        if (payload.isolated) {
          scope.setTag('isolated_diagnostic', 'true');
          scope.setFingerprint(['schema-conversion']);
        }
        scope.setTag('log_level', payload.level);
        scope.setContext('recent_logs', {
          // Objects inside this array exceed the SDK's default normalization depth.
          entries: payload.logs.map((entry) => redactDiagnosticText(entry.formatted)),
        });
        const message = redactDiagnosticText(payload.message);
        scope.setExtra('log_message', message);
        if (payload.error) {
          Sentry.captureException(payload.error);
          return;
        }
        Sentry.captureMessage(message, 'error');
      });
    },
    flush: (timeoutMs) => Sentry.flush(timeoutMs),
  },
  quickConfig.errorReportingEnabled,
  Boolean(process.env.SENTRY_DSN),
);
