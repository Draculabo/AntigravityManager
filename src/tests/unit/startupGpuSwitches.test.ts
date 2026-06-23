import { describe, expect, it, vi } from 'vitest';

import {
  applyStartupGpuSwitches,
  type StartupGpuSwitchTarget,
} from '@/modules/app-shell/utils/startupGpuSwitches';

function createTarget() {
  const target: StartupGpuSwitchTarget = {
    disableHardwareAcceleration: vi.fn(),
    commandLine: {
      appendSwitch: vi.fn(),
    },
  };

  return target;
}

describe('applyStartupGpuSwitches', () => {
  it('applies historical Linux GPU-safe startup switches', () => {
    const target = createTarget();

    const result = applyStartupGpuSwitches(target, 'linux', {});

    expect(target.disableHardwareAcceleration).toHaveBeenCalledOnce();
    expect(target.commandLine.appendSwitch).toHaveBeenNthCalledWith(1, 'disable-gpu');
    expect(target.commandLine.appendSwitch).toHaveBeenNthCalledWith(
      2,
      'disable-gpu-compositing',
    );
    expect(result.disabledHardwareAcceleration).toBe(true);
    expect(result.appliedSwitches).toEqual(['disable-gpu', 'disable-gpu-compositing']);
  });

  it('fully disables Windows GPU startup when ANTIGRAVITY_DISABLE_GPU is 1', () => {
    const target = createTarget();

    const result = applyStartupGpuSwitches(target, 'win32', {
      ANTIGRAVITY_DISABLE_GPU: '1',
    });

    expect(target.disableHardwareAcceleration).toHaveBeenCalledOnce();
    expect(target.commandLine.appendSwitch).toHaveBeenNthCalledWith(1, 'disable-gpu');
    expect(target.commandLine.appendSwitch).toHaveBeenNthCalledWith(
      2,
      'disable-gpu-compositing',
    );
    expect(result.disabledHardwareAcceleration).toBe(true);
    expect(result.appliedSwitches).toEqual(['disable-gpu', 'disable-gpu-compositing']);
  });

  it('applies no startup GPU switches on Windows by default', () => {
    const target = createTarget();

    const result = applyStartupGpuSwitches(target, 'win32', {});

    expect(target.disableHardwareAcceleration).not.toHaveBeenCalled();
    expect(target.commandLine.appendSwitch).not.toHaveBeenCalled();
    expect(result.disabledHardwareAcceleration).toBe(false);
    expect(result.appliedSwitches).toEqual([]);
  });

  it('fully disables Windows GPU startup when ANTIGRAVITY_DISABLE_GPU is true', () => {
    const target = createTarget();

    const result = applyStartupGpuSwitches(target, 'win32', {
      ANTIGRAVITY_DISABLE_GPU: 'true',
    });

    expect(target.disableHardwareAcceleration).toHaveBeenCalledOnce();
    expect(target.commandLine.appendSwitch).toHaveBeenNthCalledWith(1, 'disable-gpu');
    expect(target.commandLine.appendSwitch).toHaveBeenNthCalledWith(
      2,
      'disable-gpu-compositing',
    );
    expect(result.disabledHardwareAcceleration).toBe(true);
    expect(result.appliedSwitches).toEqual(['disable-gpu', 'disable-gpu-compositing']);
  });

  it('does not apply startup GPU switches on macOS', () => {
    const target = createTarget();

    const result = applyStartupGpuSwitches(target, 'darwin', {});

    expect(target.disableHardwareAcceleration).not.toHaveBeenCalled();
    expect(target.commandLine.appendSwitch).not.toHaveBeenCalled();
    expect(result.disabledHardwareAcceleration).toBe(false);
    expect(result.appliedSwitches).toEqual([]);
  });
});
