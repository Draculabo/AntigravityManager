import { beforeEach, describe, expect, it, vi } from 'vitest';
import { executeSwitchFlow } from '@/modules/antigravity-runtime/switch/switchFlow';

const {
  applyDeviceProfile,
  closeAntigravity,
  isProcessRunning,
  recordSwitchFailure,
  recordSwitchSuccess,
  refreshAntigravityProcessCache,
  startAntigravity,
  syncTelemetryServiceMachineIdValue,
  waitForProcessExit,
} = vi.hoisted(() => ({
  applyDeviceProfile: vi.fn(),
  closeAntigravity: vi.fn(async () => undefined),
  isProcessRunning: vi.fn(async () => true),
  recordSwitchFailure: vi.fn(),
  recordSwitchSuccess: vi.fn(),
  refreshAntigravityProcessCache: vi.fn(async () => undefined),
  startAntigravity: vi.fn(async () => undefined),
  syncTelemetryServiceMachineIdValue: vi.fn(),
  waitForProcessExit: vi.fn(async () => undefined),
}));

vi.mock('@/modules/antigravity-runtime/ipc/handler', () => ({
  closeAntigravity,
  isProcessRunning,
  startAntigravity,
  _waitForProcessExit: waitForProcessExit,
}));

vi.mock('@/shared/platform/paths', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/shared/platform/paths')>();
  return {
    ...actual,
    refreshAntigravityProcessCache,
  };
});

vi.mock('@/modules/identity-profile/ipc/handler', () => ({
  applyDeviceProfile,
  syncTelemetryServiceMachineIdValue,
}));

vi.mock('@/modules/antigravity-runtime/switch/switchMetrics', () => ({
  recordSwitchSuccess,
  recordSwitchFailure,
}));

describe('executeSwitchFlow for agy CLI', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    applyDeviceProfile.mockImplementation(() => undefined);
    isProcessRunning.mockImplementation(async () => true);
    syncTelemetryServiceMachineIdValue.mockImplementation(() => undefined);
  });

  it('only runs the switch operation without process or profile side effects', async () => {
    const performSwitch = vi.fn(async () => undefined);

    await executeSwitchFlow({
      scope: 'cloud',
      appTarget: 'agy' as never,
      targetProfile: null,
      applyFingerprint: true,
      useCredentialStore: true,
      processExitTimeoutMs: 10000,
      performSwitch,
    });

    expect(performSwitch).toHaveBeenCalledTimes(1);
    expect(refreshAntigravityProcessCache).not.toHaveBeenCalled();
    expect(closeAntigravity).not.toHaveBeenCalled();
    expect(waitForProcessExit).not.toHaveBeenCalled();
    expect(applyDeviceProfile).not.toHaveBeenCalled();
    expect(syncTelemetryServiceMachineIdValue).not.toHaveBeenCalled();
    expect(startAntigravity).not.toHaveBeenCalled();
    expect(recordSwitchSuccess).toHaveBeenCalledWith('cloud');
    expect(recordSwitchFailure).not.toHaveBeenCalled();
  });

  it('aborts GUI switching when the target process does not exit', async () => {
    const performSwitch = vi.fn(async () => undefined);
    const afterSwitchSuccess = vi.fn(async () => undefined);
    waitForProcessExit.mockRejectedValueOnce(new Error('process_exit_timeout'));

    await expect(
      executeSwitchFlow({
        scope: 'cloud',
        appTarget: 'classic',
        targetProfile: null,
        applyFingerprint: false,
        useCredentialStore: true,
        processExitTimeoutMs: 10000,
        performSwitch,
        afterSwitchSuccess,
      }),
    ).rejects.toThrow('process_exit_timeout');

    expect(closeAntigravity).toHaveBeenCalledWith('classic');
    expect(waitForProcessExit).toHaveBeenCalledWith(10000, 100, 'classic');
    expect(performSwitch).not.toHaveBeenCalled();
    expect(applyDeviceProfile).not.toHaveBeenCalled();
    expect(startAntigravity).not.toHaveBeenCalled();
    expect(afterSwitchSuccess).not.toHaveBeenCalled();
    expect(recordSwitchSuccess).not.toHaveBeenCalled();
    expect(recordSwitchFailure).toHaveBeenCalledWith(
      'cloud',
      'process_close_failed',
      'process_exit_timeout',
    );
  });

  it('continues when device profile apply fails for credential-store-backed GUI targets', async () => {
    const performSwitch = vi.fn(async () => undefined);
    const targetProfile = {
      machineId: 'machine-id',
      macMachineId: 'mac-machine-id',
      devDeviceId: 'dev-device-id',
      sqmId: 'sqm-id',
    };
    applyDeviceProfile.mockImplementationOnce(() => {
      throw new Error('storage_write_failed:parse_failed');
    });

    await executeSwitchFlow({
      scope: 'cloud',
      appTarget: 'classic',
      targetProfile,
      applyFingerprint: true,
      useCredentialStore: true,
      processExitTimeoutMs: 10000,
      performSwitch,
    });

    expect(applyDeviceProfile).toHaveBeenCalledWith(targetProfile, 'classic');
    expect(syncTelemetryServiceMachineIdValue).not.toHaveBeenCalled();
    expect(performSwitch).toHaveBeenCalledTimes(1);
    expect(performSwitch.mock.invocationCallOrder[0]).toBeLessThan(
      applyDeviceProfile.mock.invocationCallOrder[0],
    );
    expect(closeAntigravity).toHaveBeenCalledWith('classic');
    expect(waitForProcessExit).toHaveBeenCalledWith(10000, 100, 'classic');
    expect(startAntigravity).toHaveBeenCalledWith('classic');
    expect(recordSwitchSuccess).toHaveBeenCalledWith('cloud');
    expect(recordSwitchFailure).not.toHaveBeenCalled();
  });

  it('applies the CLI device profile best-effort after credential-store switching', async () => {
    const performSwitch = vi.fn(async () => undefined);
    const afterSwitchSuccess = vi.fn(async () => undefined);
    const targetProfile = {
      machineId: 'machine-id',
      macMachineId: 'mac-machine-id',
      devDeviceId: 'dev-device-id',
      sqmId: 'sqm-id',
    };

    await executeSwitchFlow({
      scope: 'cloud',
      appTarget: 'agy',
      targetProfile,
      applyFingerprint: true,
      useCredentialStore: true,
      processExitTimeoutMs: 10000,
      performSwitch,
      afterSwitchSuccess,
    });

    expect(performSwitch).toHaveBeenCalledTimes(1);
    expect(applyDeviceProfile).toHaveBeenCalledWith(targetProfile, 'agy');
    expect(syncTelemetryServiceMachineIdValue).not.toHaveBeenCalled();
    expect(performSwitch.mock.invocationCallOrder[0]).toBeLessThan(
      applyDeviceProfile.mock.invocationCallOrder[0],
    );
    expect(applyDeviceProfile.mock.invocationCallOrder[0]).toBeLessThan(
      afterSwitchSuccess.mock.invocationCallOrder[0],
    );
    expect(refreshAntigravityProcessCache).not.toHaveBeenCalled();
    expect(closeAntigravity).not.toHaveBeenCalled();
    expect(waitForProcessExit).not.toHaveBeenCalled();
    expect(startAntigravity).not.toHaveBeenCalled();
    expect(recordSwitchSuccess).toHaveBeenCalledWith('cloud');
    expect(recordSwitchFailure).not.toHaveBeenCalled();
  });

  it('syncs telemetry serviceMachineId after SQLite token switching', async () => {
    const performSwitch = vi.fn(async () => undefined);
    const afterSwitchSuccess = vi.fn(async () => undefined);
    const targetProfile = {
      machineId: 'machine-id',
      macMachineId: 'mac-machine-id',
      devDeviceId: 'dev-device-id',
      sqmId: 'sqm-id',
    };

    await executeSwitchFlow({
      scope: 'cloud',
      appTarget: 'ide',
      targetProfile,
      applyFingerprint: true,
      useCredentialStore: false,
      processExitTimeoutMs: 10000,
      performSwitch,
      afterSwitchSuccess,
    });

    expect(applyDeviceProfile).toHaveBeenCalledWith(targetProfile, 'ide');
    expect(performSwitch).toHaveBeenCalledTimes(1);
    expect(syncTelemetryServiceMachineIdValue).toHaveBeenCalledWith(
      targetProfile.macMachineId,
      undefined,
      'ide',
    );
    expect(applyDeviceProfile.mock.invocationCallOrder[0]).toBeLessThan(
      performSwitch.mock.invocationCallOrder[0],
    );
    expect(performSwitch.mock.invocationCallOrder[0]).toBeLessThan(
      syncTelemetryServiceMachineIdValue.mock.invocationCallOrder[0],
    );
    expect(startAntigravity).toHaveBeenCalledWith('ide');
    expect(syncTelemetryServiceMachineIdValue.mock.invocationCallOrder[0]).toBeLessThan(
      startAntigravity.mock.invocationCallOrder[0],
    );
    expect(startAntigravity.mock.invocationCallOrder[0]).toBeLessThan(
      afterSwitchSuccess.mock.invocationCallOrder[0],
    );
    expect(recordSwitchSuccess).toHaveBeenCalledWith('cloud');
    expect(recordSwitchFailure).not.toHaveBeenCalled();
  });
});
