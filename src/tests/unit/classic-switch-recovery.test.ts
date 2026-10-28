import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { executeSwitchFlow } from '@/modules/antigravity-runtime/switch/switchFlow';
import { processError } from '@/modules/antigravity-runtime/processErrors';
import { OperationContext } from '@/shared/observability/operationContext';
import { configureErrorReportingRuntime } from '@/shared/observability/errorReporting';
import { SwitchTraceSchema, type SwitchTrace } from '@/shared/observability/switchDiagnostic';
import { sanitizeLogRecord } from '@/modules/app-shell/diagnostic-logs/sanitize-record';
import { switchContext } from '../support/runtime-switch-fixture';

const mocks = vi.hoisted(() => ({
  prepare: vi.fn(),
  ownership: vi.fn(),
  retire: vi.fn(),
  replacement: vi.fn(),
  close: vi.fn(),
  start: vi.fn(),
  capture: vi.fn(),
  terms: vi.fn(),
  rollback: vi.fn(),
  confirmTerms: vi.fn(),
}));
vi.mock('@/modules/antigravity-runtime/classicHotSwitch', () => ({
  prepareClassicHotSwitch: mocks.prepare,
  assertClassicRestartOwnership: mocks.ownership,
}));
vi.mock('@/modules/antigravity-runtime/launch', () => ({ startFromContext: mocks.start }));
vi.mock('@/modules/antigravity-runtime/stop', () => ({ stopFromContext: mocks.close }));
vi.mock('@/modules/antigravity-runtime/ideHotSwitch', () => ({
  prepareIdeHotSwitch: vi.fn(async () => null),
}));
vi.mock('@/modules/antigravity-runtime/terms/classicTermsSwitch', () => ({
  prepareClassicTermsSwitch: vi.fn(async () => ({
    captureForHotSwitch: mocks.capture,
    apply: mocks.terms,
    rollback: mocks.rollback,
    confirmHotSwitch: mocks.confirmTerms,
  })),
}));
vi.mock('@/modules/identity-profile/ipc/handler', () => ({
  applyDeviceProfile: vi.fn(),
  ensureIdentityProfileStorage: vi.fn(),
  syncTelemetryServiceMachineIdValue: vi.fn(),
}));
vi.mock('@/shared/logging/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    setSentryReporter: vi.fn(),
    setErrorReportingEnabled: vi.fn(),
  },
}));

beforeEach(() => {
  vi.resetAllMocks();
  mocks.prepare.mockResolvedValue({
    stopServices: mocks.retire,
    confirmReplacement: mocks.replacement,
  });
  mocks.confirmTerms.mockResolvedValue(true);
});
afterEach(() => {
  configureErrorReportingRuntime(
    { initialize() {}, report() {}, flush: async () => true },
    false,
    false,
  );
  vi.restoreAllMocks();
});
const context = {
  ...switchContext,
  processes: [{ pid: 100, executablePath: switchContext.executablePath, startTime: 10n, args: [] }],
};
function request() {
  return {
    scope: 'cloud' as const,
    appTarget: 'classic' as const,
    accountEmail: 'fixture@example.test',
    targetProfile: null,
    applyFingerprint: false,
    useCredentialStore: true,
    launchContext: context,
    processExitTimeoutMs: 10,
    performSwitch: vi.fn(async () => {}),
    afterSwitchSuccess: vi.fn(async () => {}),
    onSwitchTrace: vi.fn<(trace: SwitchTrace) => void>(),
  };
}
function report(options: ReturnType<typeof request>) {
  return SwitchTraceSchema.parse(options.onSwitchTrace.mock.calls[0][0]);
}

describe('Classic hot-switch recovery through the production coordinator', () => {
  it('restarts when new services retain the previous account consent slot', async () => {
    const options = request();
    mocks.confirmTerms.mockResolvedValueOnce(false);
    await executeSwitchFlow(options);
    expect(mocks.start).toHaveBeenCalledOnce();
    expect(mocks.terms).toHaveBeenCalledOnce();
    expect(report(options).outcome).toBe('recovered-by-restart');
    expect(report(options).steps.find((step) => step.outcome === 'failed')).toMatchObject({
      stage: 'terms-confirm',
      continuation: 'restart',
    });
    expect(options.afterSwitchSuccess).toHaveBeenCalledOnce();
  });
  it('keeps the main instance on hot success and finalizes exactly once', async () => {
    const options = request();
    await executeSwitchFlow(options);
    expect(options.performSwitch).toHaveBeenCalledTimes(2);
    expect(mocks.capture).toHaveBeenCalledOnce();
    expect(mocks.retire).toHaveBeenCalledOnce();
    expect(mocks.replacement).toHaveBeenCalledOnce();
    expect(mocks.close).not.toHaveBeenCalled();
    expect(mocks.start).not.toHaveBeenCalled();
    expect(options.afterSwitchSuccess).toHaveBeenCalledOnce();
    expect(report(options).outcome).toBe('hot-success');
    expect(report(options).steps.at(-1)).toMatchObject({
      stage: 'account-finalize',
      outcome: 'succeeded',
    });
  });

  it.each([
    'hot-prepare',
    'terms-capture',
    'hot-write',
    'service-stop',
    'credential-reassert',
    'service-replacement',
    'terms-confirm',
  ] as const)(
    'recovers %s with a single complete restart and preserves ordered evidence',
    async (failure) => {
      const options = request();
      const error = Object.assign(new Error('private account token=fixture-secret'), {
        code: 'EACCES',
      });
      const failing = {
        'hot-prepare': mocks.prepare,
        'terms-capture': mocks.capture,
        'hot-write': options.performSwitch,
        'service-stop': mocks.retire,
        'credential-reassert': options.performSwitch,
        'service-replacement': mocks.replacement,
        'terms-confirm': mocks.confirmTerms,
      }[failure];
      if (failure === 'credential-reassert') {
        failing.mockResolvedValueOnce(undefined);
      }
      failing.mockRejectedValueOnce(error);
      const events: string[] = [];
      mocks.close.mockImplementation(async () => {
        events.push('close-confirmed');
      });
      options.performSwitch.mockImplementation(async () => {
        events.push('write-readback');
      });
      mocks.terms.mockImplementation(async () => {
        events.push('terms');
      });
      mocks.start.mockImplementation(async () => {
        events.push('start-confirmed');
      });
      await executeSwitchFlow(options);
      expect(events.slice(-4)).toEqual([
        'close-confirmed',
        'write-readback',
        'terms',
        'start-confirmed',
      ]);
      expect(mocks.ownership).toHaveBeenCalledOnce();
      expect(mocks.close).toHaveBeenCalledExactlyOnceWith(context, 10, { forceAfterTimeout: true });
      expect(mocks.start).toHaveBeenCalledExactlyOnceWith(context);
      expect(options.afterSwitchSuccess).toHaveBeenCalledOnce();
      if (failure === 'hot-write') {
        expect(mocks.retire).not.toHaveBeenCalled();
      }
      const trace = report(options);
      expect(trace.outcome).toBe('recovered-by-restart');
      expect(trace.steps.filter((step) => step.outcome === 'failed')).toEqual([
        expect.objectContaining({
          stage: failure,
          continuation: 'restart',
          errors: [{ kind: 'native', code: 'EACCES' }],
        }),
      ]);
      expect(
        trace.steps
          .filter((step) => step.outcome === 'succeeded')
          .slice(-5)
          .map((step) => step.stage),
      ).toEqual([
        'client-close',
        'restart-write',
        'terms-restore',
        'client-start',
        'account-finalize',
      ]);
      expect(JSON.stringify(trace)).not.toContain('fixture-secret');
      expect(sanitizeLogRecord(`Switch trace v1 ${JSON.stringify(trace)}`)).toEqual({
        text: `Switch trace v1 ${JSON.stringify(trace)}`,
        removed: false,
      });
    },
  );

  it.each(['client-close', 'restart-write', 'terms-restore', 'client-start'] as const)(
    'retains both errors and partial effects when %s fails during recovery',
    async (failure) => {
      const options = request();
      const hot = processError('exit-unconfirmed');
      const recovery = Object.assign(new Error('private restart failure'), { code: 'EPERM' });
      mocks.retire.mockRejectedValueOnce(hot);
      const failing = {
        'client-close': mocks.close,
        'restart-write': options.performSwitch,
        'terms-restore': mocks.terms,
        'client-start': mocks.start,
      }[failure];
      if (failure === 'restart-write') {
        failing.mockResolvedValueOnce(undefined);
      }
      failing.mockRejectedValueOnce(recovery);
      const error = await executeSwitchFlow(options).catch((error: unknown) => error);
      expect(error).toBeInstanceOf(AggregateError);
      if (!(error instanceof AggregateError)) {
        throw new Error('Expected both failures');
      }
      expect(error.errors[1]).toBe(hot);
      expect(options.afterSwitchSuccess).not.toHaveBeenCalled();
      expect(report(options).outcome).toBe('failed');
      expect(
        report(options)
          .steps.filter((step) => step.outcome === 'failed')
          .map((step) => step.stage),
      ).toEqual(['service-stop', failure]);
      expect(mocks.start).toHaveBeenCalledTimes(failure === 'client-start' ? 1 : 0);
      if (failure === 'client-close') {
        expect(options.performSwitch).toHaveBeenCalledTimes(1);
      }
      if (failure === 'client-start') {
        expect(report(options).steps.at(-1)?.effects.client).toBe('startup-uncertain');
      }
    },
  );

  it.each([
    'switched-hot-unconfirmed',
    'target-conflict',
    'directory-conflict',
    'update-in-progress',
  ] as const)(
    'stops recovery on %s without closing or reopening another instance',
    async (reason) => {
      const options = request();
      mocks.replacement.mockRejectedValueOnce(processError('probe-failed'));
      mocks.ownership.mockRejectedValueOnce(processError(reason));
      await expect(executeSwitchFlow(options)).rejects.toBeInstanceOf(AggregateError);
      expect(mocks.close).not.toHaveBeenCalled();
      expect(mocks.start).not.toHaveBeenCalled();
      expect(options.afterSwitchSuccess).not.toHaveBeenCalled();
      expect(report(options).steps.at(-1)).toMatchObject({
        stage: 'restart-ownership',
        outcome: 'failed',
        continuation: 'stop',
      });
    },
  );

  it('uses the same operation identity and reports recovered success once, even if reporting fails', async () => {
    const capture = vi.fn(() => {
      throw new Error('reporter unavailable');
    });
    configureErrorReportingRuntime(
      { initialize() {}, report: capture, flush: async () => true },
      true,
      true,
    );
    const operation = new OperationContext('cloud-account-switch');
    const options = request();
    mocks.replacement.mockRejectedValueOnce(processError('probe-failed'));
    options.onSwitchTrace.mockImplementation((trace) => operation.setSwitchTrace(trace));
    await operation.run(async () => {
      await executeSwitchFlow(options);
      operation.completeSwitch();
      operation.completeSwitch();
    });
    expect(options.afterSwitchSuccess).toHaveBeenCalledOnce();
    expect(report(options).diagnosticId).toBe(operation.diagnosticId);
    expect(capture).toHaveBeenCalledOnce();
    expect(capture).toHaveBeenCalledWith(
      expect.objectContaining({
        level: 'warn',
        operation: expect.objectContaining({ switchTrace: report(options) }),
      }),
    );
  });

  it('selects direct restart for an absent service layout', async () => {
    const options = request();
    mocks.prepare.mockResolvedValueOnce(null);
    mocks.ownership.mockRejectedValueOnce(new Error('Hot-only ownership evidence unavailable'));
    await executeSwitchFlow(options);
    expect(mocks.retire).not.toHaveBeenCalled();
    expect(options.performSwitch).toHaveBeenCalledOnce();
    expect(mocks.start).toHaveBeenCalledOnce();
    expect(report(options).outcome).toBe('restart-success');
    expect(mocks.ownership).not.toHaveBeenCalled();
  });
});
