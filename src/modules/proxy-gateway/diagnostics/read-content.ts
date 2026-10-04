import {
  ContentDescriptorSchema,
  ContentChunkSchema,
  DiagnosticContentError,
  type ContentDescriptor,
  type ContentIdentity,
  type ContentReadInput,
  type ContentChunk,
} from './content-capability.schema';
import { logger } from '@/shared/logging/logger';

export interface DiagnosticContentReader {
  readContent(input: ContentReadInput): Promise<ContentChunk>;
  closeContent(input: ContentIdentity): Promise<{ closed: true }>;
}

/** Main-process assembly only; never expose capabilities or cURL text to renderer state. */
export async function readDiagnosticContent(
  owner: DiagnosticContentReader,
  descriptor: ContentDescriptor,
): Promise<Buffer> {
  const parsed = ContentDescriptorSchema.parse(descriptor);
  const identity: ContentIdentity = {
    epoch: parsed.epoch,
    capabilityId: parsed.capabilityId,
    kind: parsed.kind,
    resourceId: parsed.resourceId,
  };
  try {
    const result = Buffer.alloc(parsed.totalBytes);
    let cursor = 0;
    do {
      const chunk = ContentChunkSchema.parse(await owner.readContent({ ...identity, cursor }));
      const data = Buffer.from(chunk.data, 'base64');
      const expected = Math.min(parsed.chunkBytes, parsed.totalBytes - cursor);
      if (
        chunk.cursor !== cursor ||
        data.length !== expected ||
        data.toString('base64') !== chunk.data ||
        chunk.nextCursor !== cursor + expected ||
        chunk.complete !== (chunk.nextCursor === parsed.totalBytes)
      ) {
        throw new DiagnosticContentError();
      }
      data.copy(result, cursor);
      cursor = chunk.nextCursor;
    } while (cursor < parsed.totalBytes);
    return result;
  } catch {
    throw new DiagnosticContentError();
  } finally {
    // An unavailable owner cannot be cleaned up over RPC; owner expiry/shutdown bounds retention.
    try {
      await owner.closeContent(identity);
    } catch {
      logger.warn('Diagnostic content cleanup is unavailable; owner expiry bounds retention');
    }
  }
}
