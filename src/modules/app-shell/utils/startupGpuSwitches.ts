export interface StartupGpuSwitchTarget {
  disableHardwareAcceleration: () => void;
  commandLine: { appendSwitch: (switch_: string, value?: string) => void };
}

export interface ApplyStartupGpuSwitchesResult {
  disabledHardwareAcceleration: boolean;
  appliedSwitches: string[];
}

const isFullGpuDisableEnabled = (env: NodeJS.ProcessEnv) => {
  const value = env.ANTIGRAVITY_DISABLE_GPU?.toLowerCase();

  return value === '1' || value === 'true';
};

/**
 * Applies platform-conditional GPU-safe Chromium switches at Electron startup.
 *
 * - linux: unchanged historical behavior - disable hardware acceleration plus
 *   `disable-gpu` and `disable-gpu-compositing`.
 * - win32: opt-in fallback for the white-screen-then-close GPU-process crash.
 *     - default (no env flag): apply nothing; hardware acceleration stays ON
 *       so users who are not affected keep normal rendering.
 *     - `ANTIGRAVITY_DISABLE_GPU=1` (or "true"): fully disable the GPU -
 *       disableHardwareAcceleration() plus `disable-gpu` and
 *       `disable-gpu-compositing`.
 * - all other platforms (darwin etc.): apply nothing (no regression).
 */
export function applyStartupGpuSwitches(
  target: StartupGpuSwitchTarget,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): ApplyStartupGpuSwitchesResult {
  const result: ApplyStartupGpuSwitchesResult = {
    disabledHardwareAcceleration: false,
    appliedSwitches: [],
  };

  const disableHardwareAcceleration = () => {
    target.disableHardwareAcceleration();
    result.disabledHardwareAcceleration = true;
  };

  const appendSwitch = (switch_: string) => {
    target.commandLine.appendSwitch(switch_);
    result.appliedSwitches.push(switch_);
  };

  if (platform === 'linux') {
    disableHardwareAcceleration();
    appendSwitch('disable-gpu');
    appendSwitch('disable-gpu-compositing');

    return result;
  }

  if (platform === 'win32') {
    // Windows GPU intervention is strictly opt-in: only when the user sets
    // ANTIGRAVITY_DISABLE_GPU do we change startup behavior, so unaffected
    // users keep full hardware acceleration. This mirrors the maintainer's
    // request for a fallback that does not force --no-sandbox or a forced
    // software-compositing path on every Windows launch.
    if (isFullGpuDisableEnabled(env)) {
      disableHardwareAcceleration();
      appendSwitch('disable-gpu');
      appendSwitch('disable-gpu-compositing');
    }
  }

  return result;
}
