import { z } from 'zod';
import { AUDIT_SESSION_TITLE_LIMIT } from './usage-overview.schema';

const id = z.string().min(1).max(512);
const timestamp = z.number().int().nonnegative().safe();
const cursor = z.strictObject({ sessionId: id, lastSeen: timestamp, through: timestamp });
const search = z.strictObject({
  kind: z.literal('search'),
  from: timestamp.optional(),
  to: timestamp.optional(),
  text: z.string().trim().max(AUDIT_SESSION_TITLE_LIMIT).optional(),
  cursor: cursor.optional(),
});
const selected = z.strictObject({ kind: z.literal('selected'), sessionId: id });

export const AuditSessionOptionsInputSchema = z.discriminatedUnion('kind', [search, selected]);
export const AuditSessionOptionsWorkerInputSchema = z.discriminatedUnion('kind', [
  search.extend({ asOf: timestamp }),
  selected.extend({ asOf: timestamp }),
]);
export const AuditSessionOptionSchema = z.strictObject({
  sessionId: id,
  title: z.string().min(1).max(AUDIT_SESSION_TITLE_LIMIT).optional(),
  lastSeen: timestamp,
});
export const AUDIT_SESSION_OPTIONS_LIMIT = 30;
export const AuditSessionOptionsResultSchema = z.strictObject({
  rows: z.array(AuditSessionOptionSchema).max(AUDIT_SESSION_OPTIONS_LIMIT),
  next: cursor.optional(),
});

export type AuditSessionOptionsInput = z.infer<typeof AuditSessionOptionsInputSchema>;
export type AuditSessionOptionsWorkerInput = z.infer<typeof AuditSessionOptionsWorkerInputSchema>;
export type AuditSessionOption = z.infer<typeof AuditSessionOptionSchema>;
export type AuditSessionOptionsResult = z.infer<typeof AuditSessionOptionsResultSchema>;
