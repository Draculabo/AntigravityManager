import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { normalize } from '@sentry/core';
import type { logger } from '@/shared/logging/logger';

type Reporter = NonNullable<Parameters<typeof logger.setSentryReporter>[0]>;

const mocks = vi.hoisted(() => {
  const scope = {
    setTag: vi.fn(),
    setContext: vi.fn<(name: string, context: object) => void>(),
    setExtra: vi.fn(),
  };
  return {
    scope,
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
  init: vi.fn(),
  withScope: mocks.withScope,
  captureMessage: mocks.captureMessage,
  captureException: mocks.captureException,
}));

describe('Sentry logger reporting', () => {
  let report: Reporter;
  beforeAll(async () => {
    await import('@/instrument');
    report = mocks.registerReporter.mock.calls[0][0];
  });
  beforeEach(() => {
    vi.clearAllMocks();
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
