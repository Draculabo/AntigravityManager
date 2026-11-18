import { createHash } from 'node:crypto';
import type { ThoughtPartSignature } from '../../../../src/modules/proxy-gateway/thought-store/thought-part-signatures.schema';

// Reserve room for exact signature/range metadata within the 64 MiB session budget.
export const LARGE_THOUGHT_BYTES = 64 * 1024 * 1024 - 1024;
export const LARGE_THOUGHT_SESSION = 'installed-capacity-thought';
export const LARGE_THOUGHT_SIGNATURE = 'A'.repeat(64);
export const LARGE_THOUGHT_PART_SIGNATURES = [
  {
    kind: 'thought',
    position: 0,
    start: 0,
    end: LARGE_THOUGHT_BYTES,
    signature: LARGE_THOUGHT_SIGNATURE,
  },
] satisfies ThoughtPartSignature[];

export function expectedLargeThoughtTransfer() {
  const hash = createHash('sha256');
  const block = Buffer.alloc(64 * 1024, 'T');
  for (let remaining = LARGE_THOUGHT_BYTES; remaining > 0; remaining -= block.length) {
    hash.update(block.subarray(0, Math.min(remaining, block.length)));
  }
  const serializedPartSignatures = JSON.stringify(LARGE_THOUGHT_PART_SIGNATURES);
  const signatureBytes = Buffer.byteLength(LARGE_THOUGHT_SIGNATURE);
  return {
    signatureBytes,
    totalBytes: LARGE_THOUGHT_BYTES + signatureBytes + Buffer.byteLength(serializedPartSignatures),
    digest: hash.update(LARGE_THOUGHT_SIGNATURE).update(serializedPartSignatures).digest('hex'),
  };
}
