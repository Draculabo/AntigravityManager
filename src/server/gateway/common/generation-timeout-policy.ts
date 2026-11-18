import { getServerConfig } from '@/server/server-config';
import type { GenerationStreamTimeouts } from './generation-stream-timeout';

export const GENERATION_STREAM_TIMEOUTS: Readonly<GenerationStreamTimeouts> = Object.freeze({
  initialMs: 180_000,
  activityMs: 120_000,
  transitionMs: 180_000,
});

/** Generation has its own absolute budget; maintenance and lease calls keep request_timeout. */
export function getGenerationTimeoutMs(): number {
  return (getServerConfig()?.generation_timeout ?? 270) * 1000;
}
