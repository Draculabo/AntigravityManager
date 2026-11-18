import { z } from 'zod';
import type { GoogleApiErrorDetail } from './google-error-details';

const GoogleStatusSchema = z.enum([
  'CANCELLED',
  'UNKNOWN',
  'INVALID_ARGUMENT',
  'DEADLINE_EXCEEDED',
  'NOT_FOUND',
  'ALREADY_EXISTS',
  'PERMISSION_DENIED',
  'UNAUTHENTICATED',
  'RESOURCE_EXHAUSTED',
  'FAILED_PRECONDITION',
  'ABORTED',
  'OUT_OF_RANGE',
  'UNIMPLEMENTED',
  'INTERNAL',
  'UNAVAILABLE',
  'DATA_LOSS',
]);
export type GoogleErrorStatus = z.infer<typeof GoogleStatusSchema>;
const EnvelopeSchema = z.object({ error: z.object({ status: GoogleStatusSchema }) });

export function readUpstreamErrorStatus(value: unknown): GoogleErrorStatus | undefined {
  const parsed = EnvelopeSchema.safeParse(value);
  return parsed.success ? parsed.data.error.status : undefined;
}

/** Only public ErrorInfo identity; arbitrary metadata and actionable account links stay private. */
export function publicGoogleErrorDetails(
  details?: readonly GoogleApiErrorDetail[],
): Array<{ '@type': string; reason: string; domain: string }> | undefined {
  const result = details
    ?.filter(
      (detail) =>
        detail.type === 'type.googleapis.com/google.rpc.ErrorInfo' &&
        typeof detail.reason === 'string' &&
        /^[A-Z][A-Z0-9_]{0,63}$/u.test(detail.reason) &&
        [
          'cloudcode-pa.googleapis.com',
          'staging-cloudcode-pa.googleapis.com',
          'autopush-cloudcode-pa.googleapis.com',
        ].includes(detail.domain ?? ''),
    )
    .slice(0, 8)
    .map((detail) => ({
      '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
      reason: detail.reason!,
      domain: detail.domain!,
    }));
  return result?.length ? result : undefined;
}
