import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { normalize } from '@sentry/core';
import type { logger } from '@/shared/logging/logger';
import type { ErrorEvent } from '@sentry/node';
import { loginDiagnostic } from '../fixtures/oauth-diagnostic';

type Reporter = NonNullable<Parameters<typeof logger.setSentryReporter>[0]>;
type EventContext = NonNullable<ErrorEvent['contexts']>[string];

const mocks = vi.hoisted(() => {
  const scope = {
    setTag: vi.fn(),
    setContext: vi.fn<(name: string, context: EventContext) => void>(),
    setExtra: vi.fn(),
    setFingerprint: vi.fn(),
  };
  return {
    scope,
    init: vi.fn<(options: { beforeSend(event: ErrorEvent): ErrorEvent | null }) => void>(),
    registerReporter: vi.fn<(reporter: Reporter) => void>(),
    captureMessage: vi.fn(),
    captureException: vi.fn(),
    withScope: (callback: (value: typeof scope) => void) => callback(scope),
  };
});

vi.mock('electron', () => ({
  app: { getPath: () => '/test', getVersion: () => '0.23.0', on: vi.fn() },
}));
vi.mock('@/shared/logging/logger', () => ({
  logger: {
    error: vi.fn(),
    warn: vi.fn(),
    setErrorReportingEnabled: vi.fn(),
    setSentryReporter: mocks.registerReporter,
  },
}));
vi.mock('@/shared/observability/openTelemetry', () => ({
  initializeOpenTelemetry: vi.fn(),
  shutdownOpenTelemetry: vi.fn(),
}));
vi.mock('@/shared/observability/observabilityConfig', () => ({
  getQuickObservabilityConfig: () => ({ telemetryEnabled: false, errorReportingEnabled: true }),
}));
vi.mock('@sentry/electron/main', () => ({
  init: mocks.init,
  withScope: mocks.withScope,
  captureMessage: mocks.captureMessage,
  captureException: mocks.captureException,
}));

describe('Sentry logger reporting', () => {
  let report: Reporter;
  let beforeSend: (event: ErrorEvent) => ErrorEvent | null;
  beforeAll(async () => {
    vi.stubEnv('SENTRY_DSN', 'https://fixture@example.invalid/1');
    await import('@/instrument');
    report = mocks.registerReporter.mock.calls[0][0];
    beforeSend = mocks.init.mock.calls[0][0].beforeSend;
  });
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the SDK receipt and projects operation captures after default normalization', () => {
    const { reporting, ...failure } = loginDiagnostic('login-failed');
    expect(reporting.state).toBe('not-reported');
    const operation = { failure, steps: [], stepsTruncated: false };
    mocks.captureException.mockReturnValueOnce('a'.repeat(32));
    expect(report({ level: 'error', message: 'private-sentinel', logs: [], operation })).toBe(
      'a'.repeat(32),
    );
    expect(mocks.captureException).toHaveBeenCalledOnce();
    const exception = mocks.captureException.mock.calls[0][0];
    expect(exception.stack).toBeUndefined();
    expect(exception.cause).toBeUndefined();
    const serialized = mocks.scope.setContext.mock.calls[0][1];
    expect(normalize({ operation_diagnostic: serialized }, 3)).toEqual({
      operation_diagnostic: serialized,
    });
    const projected = beforeSend({
      type: undefined,
      tags: Object.fromEntries(mocks.scope.setTag.mock.calls),
      contexts: { operation_diagnostic: serialized },
      user: { email: 'private-sentinel' },
      extra: { payload: 'private-sentinel' },
      breadcrumbs: [{ message: 'private-sentinel' }],
      release: 'antigravity-manager@0.25.1',
    });
    expect(projected?.tags?.runtime).toBe('desktop-embedded');
    expect(projected?.contexts?.operation_diagnostic).toEqual(operation);
    expect(JSON.stringify(projected)).not.toContain('private-sentinel');
    expect(mocks.scope.setExtra).not.toHaveBeenCalled();
  });

  it('keeps recent log text readable after SDK context normalization', () => {
    const formatted =
      '[2026-10-07T16:25:32.000Z] [ERROR] Failed to switch cloud account {"kind":"target-write-failed"}';
    const error = new Error('Cloud account switch failed');
    report({
      level: 'error',
      message: error.message,
      error,
      logs: [
        {
          timestamp: Date.parse('2026-10-07T16:25:32Z'),
          level: 'error',
          message: error.message,
          formatted,
        },
      ],
    });
    const [name, context] = mocks.scope.setContext.mock.calls[0];
    expect(normalize({ [name]: context }, 3)).toEqual({ recent_logs: { entries: [formatted] } });
    expect(mocks.captureException).toHaveBeenCalledExactlyOnceWith(error);
    expect(mocks.captureMessage).not.toHaveBeenCalled();
  });

  it('redacts credentials, emails and local user paths before attaching readable logs', () => {
    const message =
      'access_token=fixture-access Bearer fixture-bearer go-keyring-base64:Zml4dHVyZQ== user@example.com /Users/alice/log';
    report({
      level: 'error',
      message,
      logs: [{ timestamp: 0, level: 'error', message, formatted: `[ERROR] ${message}` }],
    });
    const safeMessage =
      'access_token=[REDACTED] Bearer [REDACTED] go-keyring-base64:[REDACTED] [EMAIL REDACTED] /Users/***/log';
    expect(mocks.scope.setContext).toHaveBeenCalledExactlyOnceWith('recent_logs', {
      entries: [`[ERROR] ${safeMessage}`],
    });
    expect(mocks.scope.setExtra).toHaveBeenCalledExactlyOnceWith('log_message', safeMessage);
    expect(mocks.captureMessage).toHaveBeenCalledExactlyOnceWith(safeMessage, 'error');
  });
});
