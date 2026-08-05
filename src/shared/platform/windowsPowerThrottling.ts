import type { KoffiFunc } from 'koffi';

const PROCESS_SET_INFORMATION = 0x0200;
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
const PROCESS_POWER_THROTTLING = 4;
const PROCESS_POWER_THROTTLING_CURRENT_VERSION = 1;
const PROCESS_POWER_THROTTLING_EXECUTION_SPEED = 0x1;
const MAX_WINDOWS_PROCESS_ID = 0xffff_ffff;

/**
 * Field order and 32-bit widths must match the native structure.
 * @see https://learn.microsoft.com/windows/win32/api/processthreadsapi/ns-processthreadsapi-process_power_throttling_state
 */
interface ProcessPowerThrottlingState {
  Version: number;
  ControlMask: number;
  StateMask: number;
}

interface WindowsPowerApi {
  closeHandle: KoffiFunc<(handle: bigint) => number>;
  getLastError: KoffiFunc<() => number>;
  openProcess: KoffiFunc<
    (desiredAccess: number, inheritHandle: number, processId: number) => bigint | null
  >;
  processPowerThrottlingStateSize: number;
  setProcessInformation: KoffiFunc<
    (
      processHandle: bigint,
      processInformationClass: number,
      processInformation: ProcessPowerThrottlingState,
      processInformationSize: number,
    ) => number
  >;
}

let windowsPowerApiPromise: Promise<WindowsPowerApi> | null = null;

async function createWindowsPowerApi(): Promise<WindowsPowerApi> {
  const { default: koffi } = await import('koffi');
  const kernel32 = koffi.load('kernel32.dll');
  const processPowerThrottlingState = koffi.struct('PROCESS_POWER_THROTTLING_STATE', {
    Version: 'uint32_t',
    ControlMask: 'uint32_t',
    StateMask: 'uint32_t',
  });
  const processPowerThrottlingStatePointer = koffi.pointer(processPowerThrottlingState);

  const openProcess: WindowsPowerApi['openProcess'] = kernel32.func(
    '__stdcall',
    'OpenProcess',
    'void *',
    ['uint32_t', 'int32_t', 'uint32_t'],
  );
  const setProcessInformation: WindowsPowerApi['setProcessInformation'] = kernel32.func(
    '__stdcall',
    'SetProcessInformation',
    'int32_t',
    ['void *', 'int32_t', processPowerThrottlingStatePointer, 'uint32_t'],
  );
  const closeHandle: WindowsPowerApi['closeHandle'] = kernel32.func(
    '__stdcall',
    'CloseHandle',
    'int32_t',
    ['void *'],
  );
  const getLastError: WindowsPowerApi['getLastError'] = kernel32.func(
    '__stdcall',
    'GetLastError',
    'uint32_t',
    [],
  );

  return {
    closeHandle,
    getLastError,
    openProcess,
    processPowerThrottlingStateSize: koffi.sizeof(processPowerThrottlingState),
    setProcessInformation,
  };
}

function getWindowsPowerApi(): Promise<WindowsPowerApi> {
  windowsPowerApiPromise ??= createWindowsPowerApi();
  return windowsPowerApiPromise;
}

function validateWindowsProcessId(pid: number): void {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid > MAX_WINDOWS_PROCESS_ID) {
    throw new Error(`Invalid process ID: ${pid}`);
  }
}

/**
 * Disable execution-speed throttling for a Windows process without changing the system sleep policy.
 */
export async function disableWindowsPowerThrottling(pid = process.pid): Promise<void> {
  if (process.platform !== 'win32') {
    return;
  }

  validateWindowsProcessId(pid);
  const windowsPowerApi = await getWindowsPowerApi();
  const processHandle = windowsPowerApi.openProcess(
    PROCESS_SET_INFORMATION | PROCESS_QUERY_LIMITED_INFORMATION,
    0,
    pid,
  );
  if (!processHandle) {
    throw new Error(`OpenProcess failed with Win32 error ${windowsPowerApi.getLastError()}`);
  }

  try {
    const state: ProcessPowerThrottlingState = {
      Version: PROCESS_POWER_THROTTLING_CURRENT_VERSION,
      ControlMask: PROCESS_POWER_THROTTLING_EXECUTION_SPEED,
      StateMask: 0,
    };
    const succeeded = windowsPowerApi.setProcessInformation(
      processHandle,
      PROCESS_POWER_THROTTLING,
      state,
      windowsPowerApi.processPowerThrottlingStateSize,
    );
    if (succeeded === 0) {
      throw new Error(
        `SetProcessInformation failed with Win32 error ${windowsPowerApi.getLastError()}`,
      );
    }
  } finally {
    windowsPowerApi.closeHandle(processHandle);
  }
}
