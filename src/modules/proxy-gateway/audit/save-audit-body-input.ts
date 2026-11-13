import { z } from 'zod';
import { AuditScopedSessionIdSchema } from './audit-session-export.schema';

export const SaveAuditBodyInputSchema = z.tuple([z.string().uuid(), z.string().max(1024)]);
export const SaveAuditHarInputSchema = z.tuple([z.string().uuid(), z.string().max(1024)]);
export const SaveAuditSessionInputSchema = z.tuple([
  AuditScopedSessionIdSchema,
  z.string().max(1024),
]);
