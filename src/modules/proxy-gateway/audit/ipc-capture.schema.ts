import { z } from 'zod';
import { MAX_AUDIT_BODY_BYTES } from './audit-sanitizer';
import { AUDIT_BODY_CHUNK_BYTES } from './incremental-audit-serializer';

export const IPC_CAPTURE_CHUNK_REQUEST_BYTES = 96 * 1024;
export const IPC_CAPTURE_HEADER = 'x-agm-ipc-capture';
export const IpcCaptureCapabilitySchema = z.strictObject({
  epoch: z.string().uuid(),
  token: z.string().uuid(),
});
export const IpcCaptureBeginSchema = z.strictObject({
  path: z.string().min(1),
  sessionId: z.string().nullable(),
  model: z.string().nullable(),
});
export const IpcCaptureMetadataAppendSchema = z.strictObject({
  capability: IpcCaptureCapabilitySchema,
  field: z.enum(['path', 'sessionId', 'model', 'error']),
  sequence: z.number().int().nonnegative(),
  complete: z.boolean(),
  data: z.string().max(Math.ceil(AUDIT_BODY_CHUNK_BYTES / 3) * 4),
});
export const IpcCapturePreparedSchema = z.strictObject({ capability: IpcCaptureCapabilitySchema });
export const IpcCaptureBeginResultSchema = z.strictObject({
  capability: IpcCaptureCapabilitySchema,
  captured: z.boolean(),
});
export const IpcCapturePayloadSchema = z.strictObject({
  capability: IpcCaptureCapabilitySchema,
  direction: z.enum(['request', 'response']),
  kind: z.enum(['empty', 'json', 'text', 'binary']),
});
export const IpcCaptureAppendSchema = z.strictObject({
  capability: IpcCaptureCapabilitySchema,
  direction: z.enum(['request', 'response']),
  sequence: z.number().int().nonnegative(),
  data: z
    .string()
    .min(1)
    .max(Math.ceil(AUDIT_BODY_CHUNK_BYTES / 3) * 4),
});
export const IpcCapturePayloadFinishSchema = z.strictObject({
  capability: IpcCaptureCapabilitySchema,
  direction: z.enum(['request', 'response']),
  result: z.strictObject({
    kind: z.enum(['empty', 'json', 'text', 'binary']),
    logicalBytes: z.number().int().safe().nonnegative(),
    storedBytes: z.number().int().nonnegative().max(MAX_AUDIT_BODY_BYTES),
    oversized: z.boolean(),
    sha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/u)
      .nullable(),
  }),
});
export const IpcCaptureFinishSchema = z.strictObject({
  capability: IpcCaptureCapabilitySchema,
  outcome: z.enum(['completed', 'internal_error']),
  error: z.union([z.string(), z.strictObject({ prepared: z.literal(true) })]).nullable(),
});
export const IpcCaptureAckSchema = z.strictObject({ accepted: z.boolean() });
export type IpcCaptureCapability = z.infer<typeof IpcCaptureCapabilitySchema>;
