import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { executeSwitchFlow } from '@/modules/antigravity-runtime/switch/switchFlow';
import { switchContext } from '../support/runtime-switch-fixture';

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
  terms: vi.fn(),
}));
vi.mock('@/modules/antigravity-runtime/terms/classicTermsSwitch', () => ({
  prepareClassicTermsSwitch: mocks.terms,
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

const originalPlatform = process.platform;
beforeEach(() => {
  Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' });
  vi.clearAllMocks();
  mocks.prepare.mockResolvedValue(switchContext);
  mocks.stop.mockResolvedValue(undefined);
  mocks.start.mockResolvedValue(undefined);
  mocks.initialize.mockReset();
  mocks.apply.mockReset();
  mocks.hot.mockReset().mockResolvedValue(null);
  mocks.stopServices.mockReset().mockResolvedValue(true);
  mocks.confirmReplacement.mockReset().mockResolvedValue(true);
  mocks.assertCanRestart.mockReset().mockResolvedValue(undefined);
  mocks.terms.mockReset().mockResolvedValue(null);
});
afterEach(() =>
  Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform }),
);

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

describe('switch ownership lifecycle', () => {
  it('retains the startup cause after credentials changed without retry or success', async () => {
    const failure = Object.assign(new Error('Synthetic launch failure'), { code: 'EACCES' });
    mocks.start.mockRejectedValueOnce(failure);
    const request = options();
    await expect(executeSwitchFlow(request)).rejects.toMatchObject({
      messageKey: 'process-runtime.switched-startup-unconfirmed',
      cause: failure,
    });
    expect(request.performSwitch).toHaveBeenCalledOnce();
    expect(mocks.start).toHaveBeenCalledOnce();
    expect(request.afterSwitchSuccess).not.toHaveBeenCalled();
  });

  it('retains a required hot reassertion failure without restarting the changed client', async () => {
    const failure = Object.assign(new Error('Synthetic reassertion failure'), { code: 'ENOSPC' });
    mocks.hot.mockResolvedValue({
      stopServices: mocks.stopServices,
      confirmReplacement: mocks.confirmReplacement,
      assertCanRestart: mocks.assertCanRestart,
    });
    const request = { ...options(), appTarget: 'ide' as const };
    request.performSwitch.mockResolvedValueOnce(undefined).mockRejectedValueOnce(failure);
    await expect(executeSwitchFlow(request)).rejects.toMatchObject({
      messageKey: 'process-runtime.switched-hot-unconfirmed',
      cause: failure,
    });
    expect(request.performSwitch).toHaveBeenCalledTimes(2);
    expect(mocks.confirmReplacement).not.toHaveBeenCalled();
    expect(mocks.stop).not.toHaveBeenCalled();
    expect(mocks.start).not.toHaveBeenCalled();
    expect(request.afterSwitchSuccess).not.toHaveBeenCalled();
  });

  it('rolls back applied terms and does not start after losing ownership during terms preparation', async () => {
    const failure = new Error('Synthetic stale switch');
    let current = true;
    const apply = vi.fn(async () => {
      current = false;
    });
    const rollback = vi.fn(async () => {});
    mocks.terms.mockResolvedValue({ apply, rollback });
    const request = {
      ...options(),
      useCredentialStore: true,
      accountEmail: 'switch@example.test',
      assertCurrent: async () => {
        if (!current) {
          throw failure;
        }
      },
    };
    await expect(executeSwitchFlow(request)).rejects.toBe(failure);
    expect(apply).toHaveBeenCalledOnce();
    expect(rollback).toHaveBeenCalledOnce();
    expect(mocks.start).not.toHaveBeenCalled();
    expect(request.afterSwitchSuccess).not.toHaveBeenCalled();
  });

  it.each(['closed', 'written'] as const)(
    'stops side effects after ownership is lost while %s',
    async (stage) => {
      const failure = new Error('Synthetic stale switch');
      let current = true;
      const request = {
        ...options(),
        assertCurrent: async () => {
          if (!current) {
            throw failure;
          }
        },
      };
      if (stage === 'closed') {
        mocks.stop.mockImplementationOnce(async () => {
          current = false;
        });
      } else {
        request.performSwitch.mockImplementationOnce(async () => {
          current = false;
        });
      }
      await expect(executeSwitchFlow(request)).rejects.toBe(failure);
      if (stage === 'closed') {
        expect(request.performSwitch).not.toHaveBeenCalled();
      } else {
        expect(request.performSwitch).toHaveBeenCalledOnce();
      }
      expect(mocks.start).not.toHaveBeenCalled();
      expect(request.afterSwitchSuccess).not.toHaveBeenCalled();
    },
  );

  const profile = {
    machineId: 'machine',
    macMachineId: 'mac',
    devDeviceId: 'device',
    sqmId: '{SQM}',
  };

  it.each(['preflight', 'started', 'cli-written', 'mac-hot-stopped'] as const)(
    'stops later effects after ownership changes at %s',
    async (phase) => {
      const failure = new Error('Synthetic stale switch');
      let current = true;
      const request = {
        ...options(),
        applyFingerprint: true,
        targetProfile: profile,
        appTarget: phase === 'cli-written' ? ('agy' as const) : ('ide' as const),
        assertCurrent: async () => {
          if (!current) {
            throw failure;
          }
        },
      };
      if (phase === 'preflight') {
        mocks.hot.mockImplementationOnce(async () => {
          current = false;
          return null;
        });
      } else if (phase === 'started') {
        mocks.start.mockImplementationOnce(async () => {
          current = false;
        });
      } else if (phase === 'cli-written') {
        request.performSwitch.mockImplementationOnce(async () => {
          current = false;
        });
      } else {
        Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' });
        mocks.hot.mockResolvedValue({
          stopServices: mocks.stopServices,
          confirmReplacement: mocks.confirmReplacement,
          assertCanRestart: mocks.assertCanRestart,
        });
        mocks.stopServices.mockImplementationOnce(async () => {
          current = false;
          return true;
        });
      }
      await expect(executeSwitchFlow(request)).rejects.toBe(failure);
      expect(request.afterSwitchSuccess).not.toHaveBeenCalled();
      expect(mocks.confirmReplacement).not.toHaveBeenCalled();
      if (phase === 'preflight') {
        expect(mocks.initialize).not.toHaveBeenCalled();
        expect(mocks.stop).not.toHaveBeenCalled();
        expect(request.performSwitch).not.toHaveBeenCalled();
      }
      if (phase === 'cli-written') {
        expect(mocks.apply).not.toHaveBeenCalled();
      }
      if (phase === 'mac-hot-stopped') {
        expect(request.performSwitch).toHaveBeenCalledOnce();
        expect(mocks.stop).not.toHaveBeenCalled();
      }
      expect(mocks.start).toHaveBeenCalledTimes(phase === 'started' ? 1 : 0);
    },
  );
});
