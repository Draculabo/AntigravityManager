import { execFile } from 'node:child_process';
import path from 'node:path';
import { z } from 'zod';
import { processError } from './processErrors';

interface WindowsProcessInfo {
  pid: number;
  ppid: number;
  name: string;
  executablePath: string;
  commandLine: string;
  startTime?: bigint;
}

const ProcessSchema = z.object({
  ProcessId: z.number().int().nonnegative(),
  ParentProcessId: z.number().int().nonnegative().optional().default(0),
  Name: z.string(),
  ExecutablePath: z.string().nullable(),
  CommandLine: z.string().nullable(),
  StartTime: z.string().regex(/^\d+$/).nullable().optional(),
});

/** WSL cannot load Windows DLLs; this bridge is only for Windows interop. */
export async function readWslWindowsProcesses(
  configuredExecutable: string | undefined,
  signal: AbortSignal,
  timeout: number,
  allProcesses = false,
): Promise<WindowsProcessInfo[]> {
  const image =
    configuredExecutable &&
    path.win32.basename(configuredExecutable).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  const filter =
    "Name LIKE '%antigravity%' OR Name = 'electron.exe'" +
    (image ? " OR Name = '" + image + "'" : '');
  const encodedFilter = Buffer.from(filter, 'utf8').toString('base64');
  const script = [
    '[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new();',
    "$filter=[System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('" +
      encodedFilter +
      "'));",
    'ConvertTo-Json -InputObject @(Get-CimInstance Win32_Process',
    allProcesses ? '' : '-Filter $filter',
    '| Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,CommandLine,',
    "@{Name='StartTime';Expression={if ($_.CreationDate) {$_.CreationDate.ToUniversalTime().Ticks.ToString()}}}) -Compress",
  ].join(' ');
  const stdout = await new Promise<string>((resolve, reject) => {
    execFile(
      '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      {
        encoding: 'utf8',
        signal,
        timeout,
        killSignal: 'SIGKILL',
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024,
      },
      (error, output) => {
        if (error) {
          reject(processError('probe-failed'));
        } else {
          resolve(output);
        }
      },
    );
  });
  return z
    .array(ProcessSchema)
    .parse(JSON.parse(stdout.trim() || '[]'))
    .filter((row) => row.ProcessId !== 0)
    .map((row) => ({
      pid: row.ProcessId,
      ppid: row.ParentProcessId,
      name: row.Name,
      executablePath: row.ExecutablePath ?? '',
      commandLine: row.CommandLine ?? '',
      ...(row.StartTime ? { startTime: BigInt(row.StartTime) } : {}),
    }));
}
