import { createHash } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import { getAgentDir } from '@/shared/platform/paths';

export const CORE_OWNER_COMPATIBILITY = 1;
export const CORE_OWNER_EPOCH_HEADER = 'x-agm-core-owner-epoch';
export const CoreHandshakeSchema = z.strictObject({
  version: z.literal(1),
  compatibility: z.literal(CORE_OWNER_COMPATIBILITY),
  kind: z.literal('core'),
  pid: z.number().int().positive(),
  epoch: z.uuid(),
  profile: z.string().regex(/^[a-f0-9]{64}$/u),
  ready: z.boolean(),
});
export type CoreHandshake = z.infer<typeof CoreHandshakeSchema>;

/** Only the fingerprint crosses transport; the profile location stays process-local. */
export function getProfileFingerprint(directory: string = getAgentDir()): string {
  const resolved = path.resolve(directory);
  return createHash('sha256')
    .update(process.platform === 'win32' ? resolved.toLowerCase() : resolved)
    .digest('hex');
}
