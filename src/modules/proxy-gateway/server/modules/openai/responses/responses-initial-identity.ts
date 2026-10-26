import { z } from 'zod';

const schema = z
  .object({
    version: z.literal(1),
    origin: z.enum(['client', 'content']),
    initialTaskFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict();

/** Captured before bounded history removes inline media; never a caller authorization. */
export type ResponsesInitialIdentity = Readonly<z.infer<typeof schema>>;

export function decodeResponsesInitialIdentity(value: unknown): ResponsesInitialIdentity | null {
  const decoded = schema.safeParse(value);
  return decoded.success ? Object.freeze(decoded.data) : null;
}
