import { z } from 'zod';

const ObservedMilliseconds = z.number().finite().int().nonnegative().nullable();
const ObservedBodyBytes = z.number().int().nonnegative().safe().optional();

/** Monotonic observations from physical send admission; null means unobserved. */
export const UpstreamAttemptTimingSchema = z.object({
  version: z.literal(1),
  uploadFinishedMs: ObservedMilliseconds,
  responseHeadersMs: ObservedMilliseconds,
  firstByteMs: ObservedMilliseconds,
  firstUsableOutputMs: ObservedMilliseconds,
  uploadedBodyBytes: ObservedBodyBytes,
  downloadedBodyBytes: ObservedBodyBytes,
});

export type UpstreamAttemptTiming = z.infer<typeof UpstreamAttemptTimingSchema>;

/** SQLite text is an independent boundary from the worker command. */
export function decodeUpstreamAttemptTiming(value: string | null): UpstreamAttemptTiming | null {
  return value === null ? null : UpstreamAttemptTimingSchema.parse(JSON.parse(value));
}
