import { z } from 'zod';

export const AuditScopedSessionIdSchema = z
  .string()
  .regex(/^session:(?:affinity:v1|store:v2):[a-f0-9]{64}$/u);
export const MAX_AUDIT_SESSION_REQUESTS = 2000;
export const AuditSessionSnapshotSchema = z.strictObject({
  ids: z.array(z.string().uuid()).max(MAX_AUDIT_SESSION_REQUESTS),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
});
export type AuditSessionSnapshot = z.infer<typeof AuditSessionSnapshotSchema>;
