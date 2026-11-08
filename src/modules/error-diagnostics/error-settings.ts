import { z } from 'zod';

export const ErrorDiagnosticsConfigSchema = z.object({
  max_storage_mib: z.number().int().min(0).max(10_240).default(500),
});
export type ErrorDiagnosticsConfig = z.infer<typeof ErrorDiagnosticsConfigSchema>;
