import { describe, expect, it } from 'vitest';
import {
  buildDisablePowerThrottlingScript,
  disableWindowsPowerThrottling,
} from '@/shared/platform/windowsPowerThrottling';

describe('buildDisablePowerThrottlingScript', () => {
  it('targets the requested PID with the native execution-speed throttle disabled', () => {
    const script = buildDisablePowerThrottlingScript(1234);

    expect(script).toContain('ProcessPowerThrottlingExecutionSpeed = 0x1');
    expect(script).toContain('ProcessPowerThrottling = 4');
    expect(script).toContain('ControlMask = ProcessPowerThrottlingExecutionSpeed');
    expect(script).toContain('StateMask = 0');
    expect(script).toContain('Disable(1234)');
  });

  it('rejects invalid process IDs before building a command', () => {
    expect(() => buildDisablePowerThrottlingScript(0)).toThrow('Invalid process ID');
    expect(() => buildDisablePowerThrottlingScript(Number.NaN)).toThrow('Invalid process ID');
  });

  it.runIf(process.platform === 'win32')(
    'successfully applies the setting to the current Windows process',
    async () => {
      await expect(disableWindowsPowerThrottling()).resolves.toBeUndefined();
    },
    20_000,
  );
});
