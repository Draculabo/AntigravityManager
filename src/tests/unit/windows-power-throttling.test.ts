import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const nativeMock = vi.hoisted(() => {
  const openProcess = vi.fn(() => 123n);
  const setProcessInformation = vi.fn(() => 1);
  const closeHandle = vi.fn(() => 1);
  const getLastError = vi.fn(() => 0);
  const func = vi.fn((...definition: unknown[]) => {
    switch (definition[1]) {
      case 'OpenProcess':
        return openProcess;
      case 'SetProcessInformation':
        return setProcessInformation;
      case 'CloseHandle':
        return closeHandle;
      case 'GetLastError':
        return getLastError;
      default:
        throw new Error(`Unexpected native function: ${String(definition[1])}`);
    }
  });
  const load = vi.fn(() => ({ func }));
  const processPowerThrottlingState = { name: 'PROCESS_POWER_THROTTLING_STATE' };
  const struct = vi.fn(() => processPowerThrottlingState);
  const pointer = vi.fn(() => ({ name: 'PROCESS_POWER_THROTTLING_STATE *' }));
  const sizeof = vi.fn(() => 12);

  return {
    closeHandle,
    func,
    getLastError,
    load,
    openProcess,
    pointer,
    processPowerThrottlingState,
    setProcessInformation,
    sizeof,
    struct,
  };
});

vi.mock('koffi', () => ({
  default: {
    load: nativeMock.load,
    pointer: nativeMock.pointer,
    sizeof: nativeMock.sizeof,
    struct: nativeMock.struct,
  },
}));

const originalPlatform = process.platform;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { configurable: true, value: platform });
}

async function loadPowerThrottlingModule() {
  return import('@/shared/platform/windowsPowerThrottling');
}

describe('disableWindowsPowerThrottling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    nativeMock.openProcess.mockReturnValue(123n);
    nativeMock.setProcessInformation.mockReturnValue(1);
    nativeMock.closeHandle.mockReturnValue(1);
    nativeMock.getLastError.mockReturnValue(0);
  });

  afterEach(() => {
    setPlatform(originalPlatform);
  });

  it('disables execution-speed throttling through SetProcessInformation', async () => {
    setPlatform('win32');
    const { disableWindowsPowerThrottling } = await loadPowerThrottlingModule();

    await expect(disableWindowsPowerThrottling(1234)).resolves.toBeUndefined();

    expect(nativeMock.load).toHaveBeenCalledWith('kernel32.dll');
    expect(nativeMock.func).toHaveBeenCalledWith('__stdcall', 'OpenProcess', 'void *', [
      'uint32_t',
      'int32_t',
      'uint32_t',
    ]);
    expect(nativeMock.func).toHaveBeenCalledWith('__stdcall', 'SetProcessInformation', 'int32_t', [
      'void *',
      'int32_t',
      expect.anything(),
      'uint32_t',
    ]);
    expect(nativeMock.openProcess).toHaveBeenCalledWith(0x1200, 0, 1234);
    expect(nativeMock.setProcessInformation).toHaveBeenCalledWith(
      123n,
      4,
      {
        ControlMask: 0x1,
        StateMask: 0,
        Version: 1,
      },
      12,
    );
    expect(nativeMock.closeHandle).toHaveBeenCalledWith(123n);
  });

  it('does not load Koffi outside Windows', async () => {
    setPlatform('linux');
    const { disableWindowsPowerThrottling } = await loadPowerThrottlingModule();

    await expect(disableWindowsPowerThrottling(1234)).resolves.toBeUndefined();

    expect(nativeMock.load).not.toHaveBeenCalled();
  });

  it('rejects process IDs outside the Win32 DWORD range', async () => {
    setPlatform('win32');
    const { disableWindowsPowerThrottling } = await loadPowerThrottlingModule();

    await expect(disableWindowsPowerThrottling(0)).rejects.toThrow('Invalid process ID');
    await expect(disableWindowsPowerThrottling(0x1_0000_0000)).rejects.toThrow(
      'Invalid process ID',
    );
    expect(nativeMock.load).not.toHaveBeenCalled();
  });

  it('reports the Win32 error when OpenProcess fails', async () => {
    setPlatform('win32');
    nativeMock.openProcess.mockReturnValue(0n);
    nativeMock.getLastError.mockReturnValue(5);
    const { disableWindowsPowerThrottling } = await loadPowerThrottlingModule();

    await expect(disableWindowsPowerThrottling(1234)).rejects.toThrow(
      'OpenProcess failed with Win32 error 5',
    );
    expect(nativeMock.setProcessInformation).not.toHaveBeenCalled();
    expect(nativeMock.closeHandle).not.toHaveBeenCalled();
  });

  it('closes the process handle when SetProcessInformation fails', async () => {
    setPlatform('win32');
    nativeMock.setProcessInformation.mockReturnValue(0);
    nativeMock.getLastError.mockReturnValue(87);
    const { disableWindowsPowerThrottling } = await loadPowerThrottlingModule();

    await expect(disableWindowsPowerThrottling(1234)).rejects.toThrow(
      'SetProcessInformation failed with Win32 error 87',
    );
    expect(nativeMock.closeHandle).toHaveBeenCalledWith(123n);
  });
});
