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
}));
vi.mock('@/modules/antigravity-runtime/launchContext', () => ({
  prepareLaunchContext: mocks.prepare,
}));
vi.mock('@/modules/antigravity-runtime/launch', () => ({ startFromContext: mocks.start }));
vi.mock('@/modules/antigravity-runtime/stop', () => ({ stopFromContext: mocks.stop }));
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

  it('closes a running IDE before writing credentials during restart switching', async () => {
    const events: string[] = [];
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
    expect(mocks.stop).toHaveBeenCalledExactlyOnceWith(switchContext, 10000);
    expect(mocks.start).toHaveBeenCalledExactlyOnceWith(switchContext);
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
