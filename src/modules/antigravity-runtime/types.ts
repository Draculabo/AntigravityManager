import { z } from 'zod';
import type { PathResolutionOptions } from '@/shared/platform/paths';

export type GuiTarget = 'classic' | 'ide';

export const ProcessOperationSchema = z.enum(['idle', 'starting', 'stopping', 'switching']);
export type ProcessOperation = z.infer<typeof ProcessOperationSchema>;

export interface RuntimeProcess {
  readonly pid: number;
  readonly executablePath: string;
  /** Native identity metadata; the WSL Windows bridge does not provide it. */
  readonly startTime?: bigint;
  readonly args: readonly string[];
  readonly cwd?: string;
}

/** Captured before closing the app; reused by injection, profile writes and launch. */
export interface LaunchContext {
  readonly target: GuiTarget;
  readonly executablePath: string;
  readonly args: readonly string[];
  readonly defaultUserDataDir: string;
  readonly pathOptions: Readonly<PathResolutionOptions>;
  readonly processes: readonly RuntimeProcess[];
}
