import { execFile } from 'node:child_process';

const WINDOWS_POWER_THROTTLING_COMMAND_TIMEOUT_MS = 15_000;

export function buildDisablePowerThrottlingScript(pid: number): string {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new Error(`Invalid process ID: ${pid}`);
  }

  return `
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class AntigravityPowerThrottling {
    [StructLayout(LayoutKind.Sequential)]
    private struct ProcessPowerThrottlingState {
        public UInt32 Version;
        public UInt32 ControlMask;
        public UInt32 StateMask;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(UInt32 desiredAccess, bool inheritHandle, UInt32 processId);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetProcessInformation(
        IntPtr processHandle,
        Int32 processInformationClass,
        ref ProcessPowerThrottlingState processInformation,
        UInt32 processInformationSize
    );

    [DllImport("kernel32.dll")]
    private static extern bool CloseHandle(IntPtr handle);

    public static Int32 Disable(UInt32 processId) {
        const UInt32 ProcessSetInformation = 0x0200;
        const UInt32 ProcessQueryLimitedInformation = 0x1000;
        const UInt32 ProcessPowerThrottlingExecutionSpeed = 0x1;
        const Int32 ProcessPowerThrottling = 4;

        IntPtr handle = OpenProcess(
            ProcessSetInformation | ProcessQueryLimitedInformation,
            false,
            processId
        );
        if (handle == IntPtr.Zero) {
            return Marshal.GetLastWin32Error();
        }

        try {
            ProcessPowerThrottlingState state = new ProcessPowerThrottlingState {
                Version = 1,
                ControlMask = ProcessPowerThrottlingExecutionSpeed,
                StateMask = 0
            };
            bool succeeded = SetProcessInformation(
                handle,
                ProcessPowerThrottling,
                ref state,
                (UInt32)Marshal.SizeOf(state)
            );
            return succeeded ? 0 : Marshal.GetLastWin32Error();
        } finally {
            CloseHandle(handle);
        }
    }
}
'@

$result = [AntigravityPowerThrottling]::Disable(${pid})
if ($result -ne 0) {
    Write-Error "SetProcessInformation failed with Win32 error $result"
    exit $result
}
`.trim();
}

export async function disableWindowsPowerThrottling(pid = process.pid): Promise<void> {
  if (process.platform !== 'win32') {
    return;
  }

  const script = buildDisablePowerThrottlingScript(pid);
  await new Promise<void>((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script],
      {
        encoding: 'utf8',
        timeout: WINDOWS_POWER_THROTTLING_COMMAND_TIMEOUT_MS,
        windowsHide: true,
      },
      (error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      },
    );
  });
}
