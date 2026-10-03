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
}

const ProcessSchema = z.object({
  ProcessId: z.number().int().positive(),
  ParentProcessId: z.number().int().nonnegative().optional().default(0),
  Name: z.string(),
  ExecutablePath: z.string().nullable(),
  CommandLine: z.string().nullable(),
});

/** WSL cannot load Windows DLLs; this bridge is only for Windows interop. */
export async function readWslWindowsProcesses(
  configuredExecutable: string | undefined,
  signal: AbortSignal,
  timeout: number,
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
    '-Filter $filter',
    '| Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,CommandLine) -Compress',
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
    .map((row) => ({
      pid: row.ProcessId,
      ppid: row.ParentProcessId,
      name: row.Name,
      executablePath: row.ExecutablePath ?? '',
      commandLine: row.CommandLine ?? '',
    }));
}
