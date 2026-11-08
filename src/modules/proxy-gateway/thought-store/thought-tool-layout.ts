import { createHash } from 'node:crypto';
import type { ThoughtPartSignature } from './thought-part-signatures';

/** Layout and complete tool identity; recovery views may already redact evicted signatures. */
export function thoughtToolLayoutDigest(parts: readonly ThoughtPartSignature[]): string {
  const digest = createHash('sha256');
  for (const part of parts) {
    if (part.kind === 'tool') {
      digest.update(JSON.stringify([part.position, part.callId, part.name, part.argsDigest]));
      digest.update('\n');
    }
  }
  return digest.digest('hex');
}
