import { z } from 'zod';
import type { ThoughtPartSignature } from './thought-part-signatures';
import type { ThoughtProvenance } from './thought-record-provenance';

export interface ThoughtRecordInput extends ThoughtProvenance {
  fingerprint: string;
  model: string | null;
  signature: string | null;
  partSignatures: ThoughtPartSignature[];
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
  readFailures: z.number().int().nonnegative().optional(),
  hydrationAdmissionFailures: z.number().int().nonnegative().optional(),
  records: z.number().int().nonnegative().optional(),
  recoverableToolLinks: z.number().int().nonnegative().max(10_000).optional(),
  memoryRecords: z.number().int().nonnegative().optional(),
  memoryBytes: z.number().int().nonnegative().optional(),
  maintenanceState: z.enum(['running', 'scheduled', 'idle', 'stopped']).optional(),
  maintenanceBlockedReason: z
    .enum(['checkpoint_busy', 'no_progress', 'oversized_record', 'active_sessions'])
    .optional(),
  lastWriteFailure: z
    .enum([
      'disk_budget',
      'disk_usage_unknown',
      'checkpoint_busy',
      'reclaim_failed',
      'read_only',
      'disk_full',
      'session_capacity',
      'write_failed',
    ])
    .nullable()
    .optional(),
  workerAlive: z.boolean(),
  workerPendingBytes: z.number().int().nonnegative(),
  workerPendingCommands: z.number().int().nonnegative(),
});

export type ThoughtSessionSummary = z.infer<typeof ThoughtSessionSummarySchema>;
export type ThoughtStoreStats = z.infer<typeof ThoughtStoreStatsSchema>;
