import { z } from 'zod';

export const WeeklyWarmupGroupSchema = z.enum(['claude', 'gemini']);

export const WeeklyWarmupConfigSchema = z.object({
  enabled: z.boolean(),
  groups: z.array(WeeklyWarmupGroupSchema),
});

export type WeeklyWarmupGroup = z.infer<typeof WeeklyWarmupGroupSchema>;
export type WeeklyWarmupConfig = z.infer<typeof WeeklyWarmupConfigSchema>;

export const DEFAULT_WEEKLY_WARMUP_CONFIG: WeeklyWarmupConfig = {
  enabled: false,
  groups: ['claude', 'gemini'],
};

export interface WeeklyWarmupRequest {
  accessToken: string;
  model: 'claude-sonnet-4-6' | 'gemini-3-flash';
  projectId?: string;
  upstreamProxyUrl?: string;
  signal?: AbortSignal;
}

export interface WeeklyWarmupExecutor {
  warmup(request: WeeklyWarmupRequest): Promise<void>;
}
