import { z } from 'zod';

export const SaveAuditBodyInputSchema = z.tuple([z.string().uuid(), z.string().max(1024)]);
