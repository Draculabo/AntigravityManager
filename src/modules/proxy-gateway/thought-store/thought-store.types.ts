import { z } from 'zod';

export interface ThoughtRecordInput {
  fingerprint: string;
  model: string | null;
  signature: string | null;
  sourceFamily: string | null;
  thought: string;
  toolIds: string[];
  toolNames: string[];
  visible: string;
}

export interface ThoughtRecord extends ThoughtRecordInput {
  createdAt: number;
  id: number | string;
  oversized: boolean;
  oversizedBytes: number | null;
  oversizedSha256: string | null;
}

export const ThoughtRecordSummarySchema = z.object({
  createdAt: z.number().int(),
  id: z.number().int().positive(),
  model: z.string().nullable(),
  oversized: z.boolean(),
  oversizedBytes: z.number().int().nonnegative().nullable(),
  sourceFamily: z.string().nullable(),
  thoughtBytes: z.number().int().nonnegative(),
});

export const ThoughtRecordSummaryListSchema = z.array(ThoughtRecordSummarySchema);
export type ThoughtRecordSummary = z.infer<typeof ThoughtRecordSummarySchema>;

export const ThoughtSessionSummarySchema = z.object({
  bytes: z.number().int().nonnegative(),
  endedAt: z.number().int().nullable(),
  lastAccessed: z.number().int(),
  recordCount: z.number().int().nonnegative(),
  sessionKey: z.string(),
});

export const ThoughtSessionListSchema = z.array(ThoughtSessionSummarySchema);

export const ThoughtStoreStatsSchema = z.object({
  databaseBytes: z.number().int().nonnegative(),
  memorySessions: z.number().int().nonnegative(),
  sessions: z.number().int().nonnegative(),
  writeFailures: z.number().int().nonnegative(),
  workerAlive: z.boolean(),
  workerPendingBytes: z.number().int().nonnegative(),
  workerPendingCommands: z.number().int().nonnegative(),
});

export type ThoughtSessionSummary = z.infer<typeof ThoughtSessionSummarySchema>;
export type ThoughtStoreStats = z.infer<typeof ThoughtStoreStatsSchema>;
