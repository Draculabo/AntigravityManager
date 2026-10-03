import { z } from 'zod';
import type { ProcessInfo } from '@draculabo/sysinfo-process-enhanced';

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

/** Validate native data; the package owns caller deadlines and shared scans. */
export async function readNativeProcessSnapshot(timeout = 1000): Promise<ProcessInfo[]> {
  processQueryModule ??= import('@draculabo/sysinfo-process-enhanced');
  const { queryProcesses } = await processQueryModule;
  const rows: unknown = await queryProcesses(timeout);
  return z.array(ProcessSchema).parse(rows);
}
