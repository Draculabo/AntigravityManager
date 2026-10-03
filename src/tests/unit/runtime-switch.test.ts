import { beforeEach, describe, expect, it, vi } from 'vitest';
import { executeSwitchFlow } from '@/modules/antigravity-runtime/switch/switchFlow';
import { switchContext } from '../support/runtime-switch-fixture';
import { processError } from '@/modules/antigravity-runtime/processErrors';
import { logger } from '@/shared/logging/logger';

const mocks = vi.hoisted(() => ({
  prepare: vi.fn(),
  stop: vi.fn(),
  start: vi.fn(),
  apply: vi.fn(),
  initialize: vi.fn(),
  sync: vi.fn(),
  hot: vi.fn(),
  stopServices: vi.fn(),
  confirmReplacement: vi.fn(),
  assertCanRestart: vi.fn(),
}));
vi.mock('@/modules/antigravity-runtime/launchContext', () => ({
  prepareLaunchContext: mocks.prepare,
}));
vi.mock('@/modules/antigravity-runtime/launch', () => ({ startFromContext: mocks.start }));
vi.mock('@/modules/antigravity-runtime/stop', () => ({ stopFromContext: mocks.stop }));
vi.mock('@/modules/antigravity-runtime/ideHotSwitch', () => ({ prepareIdeHotSwitch: mocks.hot }));
vi.mock('@/modules/identity-profile/ipc/handler', () => ({
  applyDeviceProfile: mocks.apply,
  ensureIdentityProfileStorage: mocks.initialize,
  syncTelemetryServiceMachineIdValue: mocks.sync,
}));
vi.mock('@/modules/antigravity-runtime/switch/switchMetrics', () => ({
  recordSwitchSuccess: vi.fn(),
  recordSwitchFailure: vi.fn(),
}));
vi.mock('@/shared/logging/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn() } }));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.prepare.mockResolvedValue(switchContext);
  mocks.stop.mockResolvedValue(undefined);
  mocks.start.mockResolvedValue(undefined);
  mocks.initialize.mockReset();
  mocks.hot.mockReset().mockResolvedValue(null);
  mocks.stopServices.mockReset().mockResolvedValue(true);
  mocks.confirmReplacement.mockReset().mockResolvedValue(true);
  mocks.assertCanRestart.mockReset().mockResolvedValue(undefined);
});

function options() {
  return {
    scope: 'local' as const,
    targetProfile: null,
    applyFingerprint: false,
    useCredentialStore: false,
    processExitTimeoutMs: 10000,
    performSwitch: vi.fn(async () => {}),
    afterSwitchSuccess: vi.fn(async () => {}),
  };
}

describe('switch launch safety', () => {
  const profile = {
    machineId: 'machine',
    macMachineId: 'mac',
    devDeviceId: 'device',
    sqmId: '{SQM}',
  };

  it('closes a running IDE before writing credentials when hot switching is unavailable', async () => {
    const events: string[] = [];
    mocks.hot.mockResolvedValue(null);
    mocks.stop.mockImplementation(async () => {
      events.push('close');
    });
    mocks.start.mockImplementation(async () => {
      events.push('start');
    });
    const request = {
      ...options(),
      appTarget: 'ide' as const,
      applyFingerprint: true,
      targetProfile: profile,
      performSwitch: vi.fn(async () => {
        events.push('credentials');
      }),
      afterSwitchSuccess: vi.fn(async () => {
        events.push('success');
      }),
    };
    await executeSwitchFlow(request);
    expect(events).toEqual(['close', 'credentials', 'start', 'success']);
    expect(mocks.initialize).toHaveBeenCalledExactlyOnceWith('ide', switchContext.pathOptions);
    expect(mocks.apply).toHaveBeenCalledTimes(1);
    expect(request.performSwitch).toHaveBeenCalledExactlyOnceWith(switchContext.pathOptions);
    expect(mocks.stopServices).not.toHaveBeenCalled();
    expect(mocks.stop).toHaveBeenCalledExactlyOnceWith(switchContext, 10000);
    expect(mocks.start).toHaveBeenCalledExactlyOnceWith(switchContext);
  });

  it.each(['cloud', 'local'] as const)(
    'hot switches %s IDE accounts without closing or launching the window',
    async (scope) => {
      const context = { ...switchContext, target: 'ide' as const };
      const events: string[] = [];
      mocks.hot.mockResolvedValue({
        stopServices: mocks.stopServices,
        confirmReplacement: mocks.confirmReplacement,
        assertCanRestart: mocks.assertCanRestart,
      });
      mocks.stopServices.mockImplementation(async () => {
        events.push('stop-services');
        return true;
      });
      mocks.confirmReplacement.mockImplementation(async () => {
        events.push('confirm-replacement');
        return true;
      });
      const request = {
        ...options(),
        scope,
        appTarget: 'ide' as const,
        launchContext: context,
        applyFingerprint: true,
        targetProfile: profile,
        performSwitch: vi.fn(async () => {
          events.push('credentials');
        }),
        afterSwitchSuccess: vi.fn(async () => {
          events.push('success');
        }),
      };
      await executeSwitchFlow(request);
      expect(events).toEqual([
        'credentials',
        'stop-services',
        'credentials',
        'confirm-replacement',
        'success',
      ]);
      expect(mocks.apply).toHaveBeenCalledTimes(1);
      expect(request.performSwitch).toHaveBeenNthCalledWith(1, context.pathOptions);
      expect(request.performSwitch).toHaveBeenNthCalledWith(2, context.pathOptions);
      expect(mocks.stop).not.toHaveBeenCalled();
      expect(mocks.start).not.toHaveBeenCalled();
    },
  );
  it('does not terminate any process when the initial hot-switch write fails', async () => {
    mocks.hot.mockResolvedValue({
      stopServices: mocks.stopServices,
      confirmReplacement: mocks.confirmReplacement,
      assertCanRestart: mocks.assertCanRestart,
    });
    const request = {
      ...options(),
      appTarget: 'ide' as const,
      launchContext: { ...switchContext, target: 'ide' as const },
    };
    request.performSwitch.mockRejectedValueOnce(new Error('write failed'));
    await expect(executeSwitchFlow(request)).rejects.toThrow('write failed');
    expect(mocks.stopServices).not.toHaveBeenCalled();
    expect(mocks.stop).not.toHaveBeenCalled();
    expect(mocks.start).not.toHaveBeenCalled();
    expect(request.afterSwitchSuccess).not.toHaveBeenCalled();
  });
  it('requires the post-termination credential write and does not report success on failure', async () => {
    mocks.hot.mockResolvedValue({
      stopServices: mocks.stopServices,
      confirmReplacement: mocks.confirmReplacement,
      assertCanRestart: mocks.assertCanRestart,
    });
    const request = {
      ...options(),
      appTarget: 'ide' as const,
      launchContext: { ...switchContext, target: 'ide' as const },
    };
    request.performSwitch
      .mockReset()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('rewrite failed'));
    await expect(executeSwitchFlow(request)).rejects.toMatchObject({
      messageKey: 'process-runtime.switched-hot-unconfirmed',
    });
    expect(mocks.confirmReplacement).not.toHaveBeenCalled();
    expect(request.afterSwitchSuccess).not.toHaveBeenCalled();
    expect(mocks.start).not.toHaveBeenCalled();
  });
  it('falls back to one full restart if service replacement cannot be confirmed', async () => {
    mocks.hot.mockResolvedValue({
      stopServices: mocks.stopServices,
      confirmReplacement: mocks.confirmReplacement,
      assertCanRestart: mocks.assertCanRestart,
    });
    mocks.confirmReplacement.mockResolvedValue(false);
    const request = {
      ...options(),
      appTarget: 'ide' as const,
      launchContext: { ...switchContext, target: 'ide' as const },
    };
    await executeSwitchFlow(request);
    expect(mocks.stop).toHaveBeenCalledTimes(1);
    expect(mocks.start).toHaveBeenCalledTimes(1);
    expect(request.performSwitch).toHaveBeenCalledTimes(3);
    expect(request.afterSwitchSuccess).toHaveBeenCalledTimes(1);
  });
  it('does not reopen a main window closed during hot switching', async () => {
    mocks.hot.mockResolvedValue({
      stopServices: mocks.stopServices,
      confirmReplacement: mocks.confirmReplacement,
      assertCanRestart: mocks.assertCanRestart,
    });
    mocks.confirmReplacement.mockRejectedValue(processError('switched-hot-unconfirmed'));
    const request = {
      ...options(),
      appTarget: 'ide' as const,
      launchContext: { ...switchContext, target: 'ide' as const },
    };
    await expect(executeSwitchFlow(request)).rejects.toMatchObject({
      messageKey: 'process-runtime.switched-hot-unconfirmed',
    });
    expect(mocks.stop).not.toHaveBeenCalled();
    expect(mocks.start).not.toHaveBeenCalled();
    expect(request.afterSwitchSuccess).not.toHaveBeenCalled();
  });

  it('does not perform fallback when the window was closed at the recovery deadline', async () => {
    mocks.hot.mockResolvedValue({
      stopServices: mocks.stopServices,
      confirmReplacement: mocks.confirmReplacement,
      assertCanRestart: mocks.assertCanRestart,
    });
    mocks.confirmReplacement.mockResolvedValue(false);
    mocks.assertCanRestart.mockRejectedValue(processError('switched-hot-unconfirmed'));
    const request = {
      ...options(),
      appTarget: 'ide' as const,
      launchContext: { ...switchContext, target: 'ide' as const },
    };
    await expect(executeSwitchFlow(request)).rejects.toMatchObject({
      messageKey: 'process-runtime.switched-hot-unconfirmed',
    });
    expect(mocks.stop).not.toHaveBeenCalled();
    expect(mocks.start).not.toHaveBeenCalled();
    expect(request.afterSwitchSuccess).not.toHaveBeenCalled();
  });

  it('initializes the captured target before closing and applies its profile before credentials', async () => {
    const request = {
      ...options(),
      targetProfile: profile,
      applyFingerprint: true,
      useCredentialStore: true,
    };
    await executeSwitchFlow(request);
    expect(mocks.initialize).toHaveBeenCalledExactlyOnceWith(undefined, switchContext.pathOptions);
    expect(mocks.initialize.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.stop.mock.invocationCallOrder[0],
    );
    expect(mocks.apply).toHaveBeenCalledExactlyOnceWith(
      profile,
      undefined,
      switchContext.pathOptions,
    );
    expect(mocks.apply.mock.invocationCallOrder[0]).toBeLessThan(
      request.performSwitch.mock.invocationCallOrder[0],
    );
    expect(mocks.start).toHaveBeenCalledExactlyOnceWith(switchContext);
    expect(request.afterSwitchSuccess).toHaveBeenCalledTimes(1);
  });

  it('leaves the running app and credentials unchanged when storage preflight fails', async () => {
    const request = {
      ...options(),
      targetProfile: profile,
      applyFingerprint: true,
      useCredentialStore: true,
    };
    mocks.initialize.mockImplementationOnce(() => {
      throw new Error('invalid storage');
    });
    await expect(executeSwitchFlow(request)).rejects.toThrow('invalid storage');
    expect(mocks.stop).not.toHaveBeenCalled();
    expect(mocks.apply).not.toHaveBeenCalled();
    expect(request.performSwitch).not.toHaveBeenCalled();
    expect(mocks.start).not.toHaveBeenCalled();
    expect(request.afterSwitchSuccess).not.toHaveBeenCalled();
  });

  it('fails preflight before closing, writing an account or applying a profile', async () => {
    const request = options();
    mocks.prepare.mockRejectedValue(new Error('target conflict'));
    await expect(executeSwitchFlow(request)).rejects.toThrow('target conflict');
    expect(mocks.stop).not.toHaveBeenCalled();
    expect(request.performSwitch).not.toHaveBeenCalled();
    expect(mocks.apply).not.toHaveBeenCalled();
    expect(mocks.start).not.toHaveBeenCalled();
  });

  it('does not write account data if closing cannot be confirmed', async () => {
    const request = options();
    mocks.stop.mockRejectedValue(new Error('exit unconfirmed'));
    await expect(executeSwitchFlow(request)).rejects.toThrow('exit unconfirmed');
    expect(request.performSwitch).not.toHaveBeenCalled();
    expect(mocks.start).not.toHaveBeenCalled();
  });

  it.each([
    ['exit-unconfirmed', true],
    ['close-failed', false],
    ['probe-failed', false],
    ['target-conflict', false],
  ] as const)(
    'records %s without misclassifying close failures as timeouts',
    async (reason, exitUnconfirmed) => {
      const request = options();
      mocks.stop.mockRejectedValueOnce(processError(reason));
      await expect(executeSwitchFlow(request)).rejects.toMatchObject({
        messageKey: `process-runtime.${reason}`,
      });
      expect(logger.info).toHaveBeenCalledWith(
        '[timing] switch.execute',
        expect.objectContaining({
          status: 'failure',
          stage: 'close',
          failureReason: 'process_close_failed',
          exitUnconfirmed,
        }),
      );
      expect(request.performSwitch).not.toHaveBeenCalled();
      expect(mocks.start).not.toHaveBeenCalled();
    },
  );

  it('reports partial completion without a second start or success notification', async () => {
    const request = options();
    mocks.start.mockRejectedValue(new Error('startup unconfirmed'));
    await expect(executeSwitchFlow(request)).rejects.toMatchObject({
      messageKey: 'process-runtime.switched-startup-unconfirmed',
    });
    expect(request.performSwitch).toHaveBeenCalledExactlyOnceWith(switchContext.pathOptions);
    expect(mocks.start).toHaveBeenCalledExactlyOnceWith(switchContext);
    expect(request.afterSwitchSuccess).not.toHaveBeenCalled();
  });

  it('uses the captured directory and executable even after the process cache would expire', async () => {
    vi.useFakeTimers();
    try {
      const request = options();
      request.performSwitch.mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 61000));
      });
      const promise = executeSwitchFlow({ ...request, launchContext: switchContext });
      await vi.advanceTimersByTimeAsync(61000);
      await promise;
      expect(mocks.prepare).not.toHaveBeenCalled();
      expect(request.performSwitch).toHaveBeenCalledExactlyOnceWith(switchContext.pathOptions);
      expect(mocks.start).toHaveBeenCalledExactlyOnceWith(switchContext);
      expect(request.afterSwitchSuccess).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
