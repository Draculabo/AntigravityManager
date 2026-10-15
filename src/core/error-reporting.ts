import * as Sentry from '@sentry/node';
import {
  configureErrorReportingRuntime,
  flushErrorReporting,
} from '@/shared/observability/errorReporting';
import { getQuickObservabilityConfig } from '@/shared/observability/observabilityConfig';
import {
  redactDiagnosticText,
  redactSentryEventLocalPaths,
} from '@/shared/observability/sentryPrivacy';
import { isolateSentryDiagnostic } from '@/shared/observability/sentryDiagnostic';
import { logger } from '@/shared/logging/logger';
import { sanitizeReportedError } from '@/shared/observability/reportedError';
import {
  attachOperationScope,
  projectOperationSentryEvent,
} from '@/shared/observability/operationSentry';

/** Called after the profile lease is acquired, before gateway admission. */
export function initializeCoreErrorReporting(): void {
  const preferencePath = process.env.ANTIGRAVITY_DESKTOP_PREFERENCES_PATH;
  // A CLI launch without the desktop preference location cannot infer consent.
  const enabled = preferencePath
    ? getQuickObservabilityConfig(undefined, preferencePath).errorReportingEnabled
    : false;
  configureErrorReportingRuntime(
    {
      // The core reports through the owned logger; automatic HTTP instrumentation can retain account data.
      initialize: () => {
        Sentry.init({
          dsn: process.env.SENTRY_DSN,
          release: process.env.SENTRY_RELEASE,
          defaultIntegrations: false,
          sendDefaultPii: false,
          beforeSend(event) {
            const projected = projectOperationSentryEvent(event);
            if (projected !== event) {
              return projected;
            }
            isolateSentryDiagnostic(event);
            redactSentryEventLocalPaths(event);
            return event;
          },
        });
      },
      report: (payload) => {
        let eventId: string | undefined;
        Sentry.withScope((scope) => {
          scope.setTag('runtime', 'standalone-core');
          if (payload.operation) {
            scope.setTag('operation_runtime', 'standalone-core');
            eventId = Sentry.captureException(attachOperationScope(scope, payload.operation));
            return;
          }
          if (payload.isolated) {
            scope.setTag('isolated_diagnostic', 'true');
            scope.setFingerprint(['schema-conversion']);
          } else {
            scope.setContext('recent_logs', {
              entries: payload.logs.map((entry) => redactDiagnosticText(entry.formatted)),
            });
          }
          if (payload.error) {
            Sentry.captureException(sanitizeReportedError(payload.error));
          } else {
            Sentry.captureMessage(redactDiagnosticText(payload.message), 'error');
          }
        });
        return eventId;
      },
      flush: (timeoutMs) => Sentry.flush(timeoutMs),
    },
    enabled,
    Boolean(process.env.SENTRY_DSN),
  );
  logger.debug('Core error reporting configured');
}

export { flushErrorReporting };
