import { z } from 'zod';
import { omitThoughtSignaturePlaceholder } from '../antigravity/ThoughtSignatureCompat';

const SignatureSchema = z
  .string()
  .min(1)
  .max(16 * 1024 * 1024)
  .nullable()
  .transform(omitThoughtSignaturePlaceholder);
const PositionSchema = z.number().int().nonnegative();
export const ThoughtPartSignaturesSchema = z
  .array(
    z.discriminatedUnion('kind', [
      z
        .object({
          kind: z.literal('thought'),
          position: PositionSchema,
          start: PositionSchema,
          end: PositionSchema,
          signature: SignatureSchema,
        })
        .strict(),
      z
        .object({
          kind: z.literal('tool'),
          position: PositionSchema,
          callId: z.string().min(1).nullable(),
          name: z.string().min(1),
          argsDigest: z.string().regex(/^[a-f0-9]{64}$/u),
          signature: SignatureSchema,
        })
        .strict(),
    ]),
  )
  .max(2000)
  .superRefine((parts, context) => {
    const positions = new Set<number>();
    let end = 0;
    for (const part of parts) {
      if (positions.has(part.position) || (part.kind === 'thought' && part.start !== end)) {
        context.addIssue({ code: 'custom', message: 'Invalid thought part layout' });
      }
      positions.add(part.position);
      if (part.kind === 'thought') {
        if (part.end < part.start) {
          context.addIssue({ code: 'custom', message: 'Invalid thought text range' });
        }
        end = part.end;
      }
    }
  });

export type ThoughtPartSignature = z.infer<typeof ThoughtPartSignaturesSchema>[number];
export type ThoughtToolSignature = Extract<ThoughtPartSignature, { kind: 'tool' }>;
