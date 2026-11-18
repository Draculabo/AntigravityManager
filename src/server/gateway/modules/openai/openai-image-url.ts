import { z } from 'zod';

const OpenAIImageUrlSchema = z.union([
  z.string().min(1),
  z.object({
    url: z.string().min(1),
    detail: z.enum(['auto', 'low', 'high']).optional(),
  }),
]);

/**
 * Normalizes the legacy string and current object forms accepted at the OpenAI image boundary.
 * The gateway keeps a string URL internally because downstream mappers only need the resource.
 */
export function resolveOpenAIImageUrl(value: unknown): string | null {
  const parsed = OpenAIImageUrlSchema.safeParse(value);
  if (!parsed.success) {
    return null;
  }

  return typeof parsed.data === 'string' ? parsed.data : parsed.data.url;
}
