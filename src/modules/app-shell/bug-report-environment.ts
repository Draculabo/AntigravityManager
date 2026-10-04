import { z } from 'zod';

export const BugReportEnvironmentSchema = z
  .object({
    appVersion: z.string().max(100),
    platform: z.string().max(100),
    osVersion: z.string().max(200),
    architecture: z.string().max(100),
    electronVersion: z.string().max(100),
    nodeVersion: z.string().max(100),
  })
  .strict();

export type BugReportEnvironment = z.infer<typeof BugReportEnvironmentSchema>;
