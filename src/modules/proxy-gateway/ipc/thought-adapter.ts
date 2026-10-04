import type { CoreRpcClient } from '@/core/rpc/client';
import { thoughtOwner, type ThoughtOperations } from '../thought-store/thought-owner.service';
import {
  ThoughtRecordInputSchema,
  ThoughtRecordOpenSchema,
  ThoughtRecordSchema,
  ThoughtOwnerError,
  thoughtResourceId,
  type ThoughtRecordInput,
} from '../thought-store/thought-owner.schema';
import { readDiagnosticContent } from '../diagnostics/read-content';

let selected: ThoughtOperations = thoughtOwner;
export function selectThoughtAdapter(
  selection:
    | { mode: 'desktop-embedded' }
    | { mode: 'standalone-core'; client: Pick<CoreRpcClient, 'thought'> },
): void {
  selected = selection.mode === 'desktop-embedded' ? thoughtOwner : selection.client.thought;
}
export function getThoughtAdapter(): ThoughtOperations {
  return selected;
}

/** Captured owner affinity spans open, chunk reads and cleanup; only the detail reaches React. */
export async function readSelectedThoughtRecord(input: ThoughtRecordInput) {
  const owner = getThoughtAdapter();
  try {
    const parsed = ThoughtRecordInputSchema.parse(input);
    const record = ThoughtRecordOpenSchema.nullable().parse(await owner.openRecord(parsed));
    if (!record) {
      return null;
    }
    if (
      record.transfer.resourceId !== thoughtResourceId(parsed) ||
      record.metadata.id !== parsed.id
    ) {
      throw new ThoughtOwnerError();
    }
    const bytes = await readDiagnosticContent(owner, record.transfer);
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const signatureOffset = record.thoughtBytes + record.visibleBytes;
    return ThoughtRecordSchema.parse({
      ...record.metadata,
      thought: decoder.decode(bytes.subarray(0, record.thoughtBytes)),
      visible: decoder.decode(bytes.subarray(record.thoughtBytes, signatureOffset)),
      signature:
        record.signatureBytes === null ? null : decoder.decode(bytes.subarray(signatureOffset)),
    });
  } catch {
    throw new ThoughtOwnerError();
  }
}
