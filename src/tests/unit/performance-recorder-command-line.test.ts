// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const appendSwitch = vi.hoisted(() => vi.fn());
vi.mock('electron', () => ({ app: { commandLine: { appendSwitch } }, contentTracing: {} }));
import { configurePerformanceRecorderCommandLine } from '@/modules/app-shell/performance-recorder/main-recorder';

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.unstubAllEnvs());
describe('performance recorder debug endpoint', () => {
  it('stays disabled unless the diagnostic flag is explicitly enabled', () => {
    vi.stubEnv('ANTIGRAVITY_ENABLE_PERFORMANCE_RECORDER', '0');
    vi.stubEnv('ANTIGRAVITY_PERFORMANCE_DEBUG_PORT', '0');
    configurePerformanceRecorderCommandLine();
    expect(appendSwitch).not.toHaveBeenCalled();
  });
  it.each(['0', '9333'])('uses localhost with debug port %s', (port) => {
    vi.stubEnv('ANTIGRAVITY_ENABLE_PERFORMANCE_RECORDER', '1');
    vi.stubEnv('ANTIGRAVITY_PERFORMANCE_DEBUG_PORT', port);
    configurePerformanceRecorderCommandLine();
    expect(appendSwitch.mock.calls).toEqual([
      ['remote-debugging-address', '127.0.0.1'],
      ['remote-debugging-port', port],
    ]);
  });
  it.each(['', ' ', '-1', '1023', '65536', '1.5', 'invalid'])('rejects invalid port %s', (port) => {
    vi.stubEnv('ANTIGRAVITY_ENABLE_PERFORMANCE_RECORDER', '1');
    vi.stubEnv('ANTIGRAVITY_PERFORMANCE_DEBUG_PORT', port);
    expect(() => configurePerformanceRecorderCommandLine()).toThrow();
    expect(appendSwitch).not.toHaveBeenCalled();
  });
});
