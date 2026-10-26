import { z } from 'zod';

import { SchemaInputError } from '@/modules/proxy-gateway/antigravity/schema/SchemaConversion';

const StreamOptionsSchema = z
  .object({ include_usage: z.boolean().optional() })
  .nullable()
  .optional();

/** Resolve the public streaming option without coercing strings into booleans. */
export function resolveOpenAIStreamUsage(value: unknown): boolean {
  const parsed = StreamOptionsSchema.safeParse(value);
  if (!parsed.success) {
    throw new SchemaInputError(
      'invalid-input',
      'Invalid stream_options: include_usage must be a boolean',
    );
  }
  return parsed.data?.include_usage ?? false;
}
