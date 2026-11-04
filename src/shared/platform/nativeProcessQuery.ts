import { z } from 'zod';
import { readFileSync } from 'node:fs';
import type { ProcessInfo } from '@draculabo/sysinfo-process-enhanced';
import { hasErrorCode } from '@/shared/errors/error-guards';

const ProcessSchema = z.object({
  pid: z.number().int().nonnegative(),
  parentPid: z.number().int().nonnegative().optional(),
  name: z.string(),
  exe: z.string().optional(),
  cmd: z.array(z.string()),
  cwd: z.string().optional(),
  startTime: z.bigint().nonnegative(),
});

// Cache only module loading, never a process query or its result.
let processQueryModule: Promise<typeof import('@draculabo/sysinfo-process-enhanced')> | undefined;

/** Use Linux's monotonic creation ticks; epoch estimates can drift when WSL corrects its clock. */
function readLinuxProcessIdentity(row: ProcessInfo): ProcessInfo[] {
  let stat: string;
  try {
    stat = readFileSync(`/proc/${row.pid}/stat`, 'utf8');
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) {
      return [];
    }
    throw error;
  }
  // comm can contain spaces and parentheses. Fields after its final ')' start at state (3).
  const match = /^(\d+) \([\s\S]*\) ([\s\S]+)$/.exec(stat.trimEnd());
  const fields = match?.[2].split(/\s+/);
  if (match?.[1] !== String(row.pid) || !fields || !/^\d+$/.test(fields[19] ?? '')) {
    throw new Error('Linux process creation identity is unavailable');
  }
  // Zombie/dead processes retain a PID but cannot read credentials or own a running client.
  if (fields[0] === 'Z' || fields[0] === 'X') {
    return [];
  }
  return [{ ...row, startTime: BigInt(fields[19]) }];
}

/** Validated identities: Linux startTime is boot-relative ticks; other platforms use native time. */
export async function readNativeProcessSnapshot(timeout = 1000): Promise<ProcessInfo[]> {
  processQueryModule ??= import('@draculabo/sysinfo-process-enhanced');
  const { queryProcesses } = await processQueryModule;
  const rows: unknown = await queryProcesses(Math.min(timeout, 30000));
  const parsed = z.array(ProcessSchema).parse(rows);
  return process.platform === 'linux' ? parsed.flatMap(readLinuxProcessIdentity) : parsed;
}
