import path from 'node:path';
import type { KoffiFunc } from 'koffi';
import koffi from 'koffi';

/** Queue normal close for this process's unowned top-level windows, including hidden ones. */
export async function requestWindowsProcessClose(pid: number): Promise<void> {
  const root = process.env.SystemRoot;
  if (!root || !path.win32.isAbsolute(root)) {
    throw new Error('Windows system directory is unavailable');
  }
  const user = koffi.load(path.win32.join(root, 'System32', 'User32.dll'));
  const kernel = koffi.load(path.win32.join(root, 'System32', 'Kernel32.dll'));
  let callback: bigint | undefined;
  try {
    const getLastError = kernel.func('uint32_t __stdcall GetLastError()') as KoffiFunc<
      () => number
    >;
    const windowPid = user.func(
      'uint32_t __stdcall GetWindowThreadProcessId(void *window, _Out_ uint32_t *pid)',
    ) as KoffiFunc<(window: bigint, pid: number[]) => number>;
    const owner = user.func(
      'void * __stdcall GetWindow(void *window, uint32_t command)',
    ) as KoffiFunc<(window: bigint, command: number) => bigint | null>;
    const close = user.func(
      'int __stdcall PostMessageW(void *window, uint32_t message, uintptr_t wparam, intptr_t lparam)',
    ) as KoffiFunc<(window: bigint, message: number, wparam: number, lparam: number) => number>;
    const callbackType = koffi.proto('__stdcall', 'int', ['void *', 'intptr_t']);
    const enumerate = user.func('__stdcall', 'EnumWindows', 'int', [
      koffi.pointer(callbackType),
      'intptr_t',
    ]);
    let queued = 0;
    let failureCode: number | undefined;
    callback = koffi.register((window: bigint) => {
      const processId = [0];
      windowPid(window, processId);
      // Owned dialogs keep their save/cancel decisions. Close their application window instead.
      const windowOwner = owner(window, 4); // GW_OWNER
      if (processId[0] !== pid || (windowOwner !== null && windowOwner !== 0n)) {
        return 1;
      }
      windowPid(window, processId);
      if (processId[0] === pid) {
        if (close(window, 0x0010, 0, 0)) {
          // WM_CLOSE
          queued++;
        } else {
          const code = getLastError();
          if (code !== 1400) {
            // The window can disappear between enumeration and posting.
            failureCode ??= code;
          }
        }
      }
      return 1;
    }, koffi.pointer(callbackType));
    if (!enumerate(callback, 0)) {
      throw new Error(`Windows window enumeration failed (${getLastError()})`);
    }
    if (failureCode !== undefined) {
      throw new Error(`Windows normal close request failed (${failureCode})`);
    }
    if (!queued) {
      throw new Error('Windows process has no closable top-level windows');
    }
  } finally {
    if (callback !== undefined) {
      koffi.unregister(callback);
    }
    kernel.unload();
    user.unload();
  }
}
