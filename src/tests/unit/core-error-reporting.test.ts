import { afterEach, describe, expect, it, vi } from 'vitest';
import { logger } from '@/shared/logging/logger';
import { setErrorReportingEnabled } from '@/shared/observability/errorReporting';
import { OperationContext } from '@/shared/observability/operationContext';
import { loginDiagnostic } from '../fixtures/oauth-diagnostic';

const sdk = vi.hoisted(() => ({
  init: vi.fn(),
  captureMessage: vi.fn(),
  captureException: vi.fn(),
  flush: vi.fn(async () => true),
  scope: { setTag: vi.fn(), setFingerprint: vi.fn(), setContext: vi.fn() },
}));
vi.mock('@sentry/node', () => ({
  ...sdk,
  withScope: (callback: (scope: typeof sdk.scope) => void) => callback(sdk.scope),
}));
vi.mock('@/shared/observability/observabilityConfig', () => ({
  getQuickObservabilityConfig: () => ({ errorReportingEnabled: false, telemetryEnabled: false }),
}));
afterEach(() => {
  logger.setErrorReportingEnabled(false);
  logger.setSentryReporter(null);
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe('standalone core error reporting adapter', () => {
  it('returns an isolated operation receipt with the same reference', async () => {
    vi.stubEnv('SENTRY_DSN', 'https://fixture@example.invalid/1');
    vi.stubEnv('ANTIGRAVITY_DESKTOP_PREFERENCES_PATH', '/fixture/preferences.json');
    const { initializeCoreErrorReporting } = await import('@/core/error-reporting');
    initializeCoreErrorReporting();
    setErrorReportingEnabled(true);
    sdk.captureException.mockReturnValueOnce('b'.repeat(32));
    const { reporting, schemaVersion, diagnosticId, operation, ...failure } =
      loginDiagnostic('login-failed');
    expect(reporting.state).toBe('not-reported');
    expect(schemaVersion).toBe(1);
    const terminal = new OperationContext(operation, diagnosticId).finish(failure);
    expect(terminal.reporting).toEqual({ state: 'captured', eventId: 'b'.repeat(32) });
    expect(sdk.scope.setTag).toHaveBeenCalledWith('diagnostic_id', diagnosticId);
    expect(sdk.scope.setTag).toHaveBeenCalledWith('runtime', 'standalone-core');
    expect(
      sdk.scope.setContext.mock.calls.every((call) => call[0] === 'operation_diagnostic'),
    ).toBe(true);
    expect(sdk.captureMessage).not.toHaveBeenCalled();
  });
  it('honors disabled preferences and can install Node reporting after an owner update', async () => {
    vi.stubEnv('SENTRY_DSN', 'https://fixture@example.invalid/1');
    vi.stubEnv('ANTIGRAVITY_DESKTOP_PREFERENCES_PATH', '/fixture/preferences.json');
    const { initializeCoreErrorReporting } = await import('@/core/error-reporting');
    initializeCoreErrorReporting();
    logger.diagnosticError('suppressed');
    expect(sdk.init).not.toHaveBeenCalled();
    expect(sdk.captureMessage).not.toHaveBeenCalled();
    setErrorReportingEnabled(true);
    logger.diagnosticError('safe schema summary');
    expect(sdk.init).toHaveBeenCalledTimes(1);
    expect(sdk.init.mock.calls[0][0]).toMatchObject({
      defaultIntegrations: false,
      sendDefaultPii: false,
    });
    expect(sdk.scope.setTag.mock.calls).toEqual([
      ['runtime', 'standalone-core'],
      ['isolated_diagnostic', 'true'],
    ]);
    expect(sdk.captureMessage).toHaveBeenCalledExactlyOnceWith('safe schema summary', 'error');
    expect(sdk.scope.setContext).not.toHaveBeenCalled();
  });
});
