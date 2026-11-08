import { z } from 'zod';

const ProjectDenialSchema = z.object({
  error: z.object({
    code: z.literal(403).optional(),
    status: z.literal('PERMISSION_DENIED').optional(),
    details: z
      .array(
        z.object({
          '@type': z.literal('type.googleapis.com/google.rpc.ErrorInfo'),
          domain: z.literal('googleapis.com'),
          reason: z.enum(['USER_PROJECT_DENIED', 'BILLING_DISABLED']),
          metadata: z.object({ consumer: z.string() }),
        }),
      )
      .min(1)
      .max(32),
  }),
});

/** Recognize the denied consumer; the caller separately owns permission to omit project. */
export function isGoogleProjectConsumerDenial(data: unknown, project: string): boolean {
  let value = data;
  if (typeof value === 'string') {
    if (Buffer.byteLength(value, 'utf8') > 64 * 1024) {
      return false;
    }
    try {
      value = JSON.parse(value);
    } catch {
      return false;
    }
  }
  const parsed = ProjectDenialSchema.safeParse(value);
  if (!parsed.success) {
    return false;
  }

  const consumer = project.startsWith('projects/') ? project : `projects/${project}`;
  return parsed.data.error.details.every((detail) => detail.metadata.consumer === consumer);
}
