import { afterEach, describe, expect, it, vi } from 'vitest';
import { logger } from '@/shared/logging/logger';
import {
  configureErrorReportingRuntime,
  flushErrorReporting,
  setErrorReportingEnabled,
} from '@/shared/observability/errorReporting';
import { isolateSentryDiagnostic } from '@/shared/observability/sentryDiagnostic';
import type { ErrorEvent } from '@sentry/node';
import { sanitizeReportedError } from '@/shared/observability/reportedError';

afterEach(() => {
  logger.setErrorReportingEnabled(false);
  logger.setSentryReporter(null);
  vi.useRealTimers();
});

describe('error reporting runtime lifecycle', () => {
  it('retains a sanitized exception stack without exporting arbitrary error fields', () => {
    const source = Object.assign(new Error('access_token=private-token user@example.com'), {
      config: { headers: { authorization: 'private' } },
    });
    source.stack = 'Error: access_token=private-token\n at /Users/alice/project.ts:12';
    const safe = sanitizeReportedError(source);
    expect(safe.message).toBe('access_token=[REDACTED] [EMAIL REDACTED]');
    expect(safe.stack).toBe('Error: access_token=[REDACTED]\n at /Users/***/project.ts:12');
    expect(Object.hasOwn(safe, 'config')).toBe(false);
  });
  it('initializes and reinstalls reporting when enabled after a disabled startup', () => {
    const initialize = vi.fn();
    const report = vi.fn();
    configureErrorReportingRuntime({ initialize, report, flush: async () => true }, false, true);
    logger.diagnosticError('safe summary');
    expect(initialize).not.toHaveBeenCalled();
    expect(report).not.toHaveBeenCalled();
    setErrorReportingEnabled(true);
    logger.diagnosticError('safe summary');
    setErrorReportingEnabled(false);
    logger.diagnosticError('suppressed');
    setErrorReportingEnabled(true);
    logger.diagnosticError('safe summary');
    expect(initialize).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledTimes(2);
    expect(report.mock.calls[0][0]).toMatchObject({ isolated: true, logs: [] });
  });

  it('continues local logging when DSN is unavailable or reporting throws', () => {
    const initialize = vi.fn();
    const report = vi.fn(() => {
      throw new Error('transport failure');
    });
    configureErrorReportingRuntime({ initialize, report, flush: async () => true }, true, false);
    logger.diagnosticError('no dsn');
    expect(initialize).not.toHaveBeenCalled();
    configureErrorReportingRuntime({ initialize, report, flush: async () => true }, true, true);
    expect(() => logger.diagnosticError('safe summary')).not.toThrow();
    expect(report).toHaveBeenCalledTimes(1);
  });

  it('bounds a hung transport flush', async () => {
    vi.useFakeTimers();
    configureErrorReportingRuntime(
      {
        initialize: () => undefined,
        report: () => undefined,
        flush: () => new Promise(() => undefined),
      },
      true,
      true,
    );
    const flushing = flushErrorReporting(50);
    await vi.advanceTimersByTimeAsync(50);
    await expect(flushing).resolves.toBeUndefined();
  });

  it('replaces inherited user data with empty geo to prevent remote IP enrichment', () => {
    const event: ErrorEvent = {
      type: undefined,
      message: 'safe summary',
      tags: { isolated_diagnostic: 'true', runtime: 'standalone-core', account: 'private' },
      user: { email: 'private', geo: { city: 'private' }, data: { account: 'private' } },
      request: { headers: { authorization: 'private' } },
      breadcrumbs: [{ message: 'private' }],
      contexts: { private: { raw: 'private' } },
      extra: { schema: 'private' },
      server_name: 'private',
      fingerprint: ['schema-conversion'],
    };
    isolateSentryDiagnostic(event);
    expect(event).toEqual({
      type: undefined,
      message: 'safe summary',
      tags: { isolated_diagnostic: 'true', runtime: 'standalone-core' },
      user: { geo: {} },
      fingerprint: ['schema-conversion'],
    });
  });

  it('preserves the existing context of events outside isolated diagnostics', () => {
    const event: ErrorEvent = {
      type: undefined,
      message: 'ordinary report',
      user: { id: 'fixture-user' },
      tags: { runtime: 'standalone-core' },
      contexts: { recent_logs: { entries: ['safe entry'] } },
    };
    isolateSentryDiagnostic(event);
    expect(event).toEqual({
      type: undefined,
      message: 'ordinary report',
      user: { id: 'fixture-user' },
      tags: { runtime: 'standalone-core' },
      contexts: { recent_logs: { entries: ['safe entry'] } },
    });
  });
});
