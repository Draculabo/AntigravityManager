import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { requestWindowsProcessClose } from '@/modules/antigravity-runtime/windowsNormalClose';

interface WindowFixture {
  handle: bigint;
  pid: number;
  owner: bigint | null;
  errorCode?: number;
}
const native = vi.hoisted(() => ({
  windows: [] as WindowFixture[],
  lastError: 0,
  enumerates: true,
  callback: undefined as ((window: bigint) => number) | undefined,
  post: vi.fn(),
  unloadUser: vi.fn(),
  unloadKernel: vi.fn(),
  unregister: vi.fn(),
  load: vi.fn(),
}));
vi.mock('koffi', () => ({
  default: {
    load: native.load,
    proto: () => 'callback',
    pointer: (type: string) => type,
    register: (callback: (window: bigint) => number) => {
      native.callback = callback;
      return 9n;
    },
    unregister: native.unregister,
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('SystemRoot', 'C:\\Windows');
  native.windows = [];
  native.lastError = 0;
  native.enumerates = true;
  native.callback = undefined;
  native.load.mockImplementation((file: string) => ({
    unload: file.endsWith('User32.dll') ? native.unloadUser : native.unloadKernel,
    func: (...args: unknown[]) => {
      const declaration = String(args[0]);
      if (declaration.includes('GetLastError')) {
        return () => native.lastError;
      }
      if (declaration.includes('GetWindowThreadProcessId')) {
        return (window: bigint, output: number[]) => {
          output[0] = native.windows.find((row) => row.handle === window)?.pid ?? 0;
          return 1;
        };
      }
      if (declaration.includes('GetWindow(')) {
        return (window: bigint) => native.windows.find((row) => row.handle === window)?.owner;
      }
      if (declaration.includes('PostMessageW')) {
        return (window: bigint, ...args: number[]) => {
          native.post(window, ...args);
          const code = native.windows.find((row) => row.handle === window)?.errorCode;
          native.lastError = code ?? 0;
          return code === undefined ? 1 : 0;
        };
      }
      if (args[1] === 'EnumWindows') {
        return () => {
          for (const window of native.windows) {
            native.callback?.(window.handle);
          }
          return native.enumerates ? 1 : 0;
        };
      }
      throw new Error('Unexpected native call');
    },
  }));
});
afterEach(() => vi.unstubAllEnvs());

describe('Windows normal close diagnostics', () => {
  it('closes only the selected process unowned windows, including hidden ones', async () => {
    native.windows = [
      { handle: 1n, pid: 42, owner: null },
      { handle: 2n, pid: 43, owner: null },
      { handle: 3n, pid: 42, owner: 1n },
    ];
    await requestWindowsProcessClose(42);
    expect(native.post.mock.calls).toEqual([[1n, 0x0010, 0, 0]]);
    expect(native.unregister).toHaveBeenCalledExactlyOnceWith(9n);
    expect(native.unloadUser).toHaveBeenCalledOnce();
    expect(native.unloadKernel).toHaveBeenCalledOnce();
  });
  it('retains access-denied from PostMessageW without private native prose', async () => {
    native.windows = [{ handle: 1n, pid: 42, owner: null, errorCode: 5 }];
    await expect(requestWindowsProcessClose(42)).rejects.toMatchObject({
      processDiagnostic: { reason: 'window-close-failed', windowsErrorCode: 5 },
    });
    expect(native.unregister).toHaveBeenCalledOnce();
  });
  it('distinguishes no application window from an exit timeout', async () => {
    await expect(requestWindowsProcessClose(42)).rejects.toMatchObject({
      processDiagnostic: { reason: 'no-closable-window' },
    });
  });
  it('retains a failed enumeration code', async () => {
    native.enumerates = false;
    native.lastError = 5;
    await expect(requestWindowsProcessClose(42)).rejects.toMatchObject({
      processDiagnostic: { reason: 'window-enumeration-failed', windowsErrorCode: 5 },
    });
  });
  it('allows a disappearing window while another close request succeeds', async () => {
    native.windows = [
      { handle: 1n, pid: 42, owner: null, errorCode: 1400 },
      { handle: 2n, pid: 42, owner: null },
    ];
    await expect(requestWindowsProcessClose(42)).resolves.toBeUndefined();
    expect(native.post).toHaveBeenCalledTimes(2);
  });
  it('releases the first library when loading the second fails', async () => {
    native.load
      .mockImplementationOnce(() => ({ unload: native.unloadUser }))
      .mockImplementationOnce(() => {
        throw new Error('private native loader path');
      });
    await expect(requestWindowsProcessClose(42)).rejects.toMatchObject({
      processDiagnostic: { reason: 'native-call-failed' },
    });
    expect(native.unloadUser).toHaveBeenCalledOnce();
    expect(native.unregister).not.toHaveBeenCalled();
  });
});
