import { describe, expect, it, vi } from 'vitest';

const closeAntigravity = vi.fn(async () => undefined);
const startAntigravity = vi.fn(async () => undefined);
const waitForProcessExit = vi.fn(async () => undefined);
const refreshAntigravityProcessCache = vi.fn(async () => undefined);
const applyDeviceProfile = vi.fn();
const recordSwitchSuccess = vi.fn();
const recordSwitchFailure = vi.fn();

vi.mock('@/modules/antigravity-runtime/ipc/handler', () => ({
  closeAntigravity,
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
}));

vi.mock('@/modules/antigravity-runtime/switch/switchMetrics', () => ({
  recordSwitchSuccess,
  recordSwitchFailure,
}));

describe('executeSwitchFlow for agy CLI', () => {
  it('only runs the switch operation without process or profile side effects', async () => {
    const { executeSwitchFlow } = await import('@/modules/antigravity-runtime/switch/switchFlow');
    const performSwitch = vi.fn(async () => undefined);

    await executeSwitchFlow({
      scope: 'cloud',
      appTarget: 'agy' as never,
      targetProfile: null,
      applyFingerprint: true,
      processExitTimeoutMs: 10000,
      performSwitch,
    });

    expect(performSwitch).toHaveBeenCalledTimes(1);
    expect(refreshAntigravityProcessCache).not.toHaveBeenCalled();
    expect(closeAntigravity).not.toHaveBeenCalled();
    expect(waitForProcessExit).not.toHaveBeenCalled();
    expect(applyDeviceProfile).not.toHaveBeenCalled();
    expect(startAntigravity).not.toHaveBeenCalled();
    expect(recordSwitchSuccess).toHaveBeenCalledWith('cloud');
    expect(recordSwitchFailure).not.toHaveBeenCalled();
  });
});
