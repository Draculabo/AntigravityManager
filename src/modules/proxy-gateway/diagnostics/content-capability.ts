import { randomUUID } from 'node:crypto';
import { clearTimeout, setTimeout } from 'node:timers';
import {
  ContentDescriptorSchema,
  ContentChunkSchema,
  DiagnosticContentError,
  DIAGNOSTIC_CHUNK_BYTES,
  DIAGNOSTIC_RETAINED_BYTES,
  DIAGNOSTIC_CONTENT_TTL_MS,
  type ContentDescriptor,
  type ContentIdentity,
  type ContentReadInput,
} from './content-capability.schema';

interface RetainedContent {
  descriptor: ContentDescriptor;
  parts: readonly Buffer[];
  cursor: number;
  timer: ReturnType<typeof setTimeout>;
}

/** Owner-local snapshots. Callers hand over buffers and must not mutate them afterward. */
export class DiagnosticContentCapabilities {
  private readonly epoch = randomUUID();
  private readonly retained = new Map<string, RetainedContent>();
  private retainedBytes = 0;
  private closed = false;
  constructor(private readonly now: () => number = Date.now) {}

  open(
    kind: ContentIdentity['kind'],
    resourceId: string,
    parts: readonly Buffer[],
  ): ContentDescriptor {
    this.expire();
    const totalBytes = parts.reduce((sum, part) => sum + part.length, 0);
    if (
      this.closed ||
      this.retained.size >= 4 ||
      totalBytes + this.retainedBytes > DIAGNOSTIC_RETAINED_BYTES
    ) {
      throw new DiagnosticContentError();
    }
    const descriptor = ContentDescriptorSchema.parse({
      epoch: this.epoch,
      capabilityId: randomUUID(),
      kind,
      resourceId,
      totalBytes,
      chunkBytes: DIAGNOSTIC_CHUNK_BYTES,
      expiresAt: this.now() + DIAGNOSTIC_CONTENT_TTL_MS,
    });
    const timer = setTimeout(() => this.remove(descriptor.capabilityId), DIAGNOSTIC_CONTENT_TTL_MS);
    timer.unref();
    this.retained.set(descriptor.capabilityId, { descriptor, parts, cursor: 0, timer });
    this.retainedBytes += totalBytes;
    return descriptor;
  }

  read(input: ContentReadInput) {
    const parsed = input;
    const content = this.resolve(parsed);
    if (parsed.cursor !== content.cursor) {
      throw new DiagnosticContentError();
    }
    const nextCursor = Math.min(
      parsed.cursor + DIAGNOSTIC_CHUNK_BYTES,
      content.descriptor.totalBytes,
    );
    const slices: Buffer[] = [];
    let offset = 0;
    for (const part of content.parts) {
      const start = Math.max(0, parsed.cursor - offset);
      const end = Math.min(part.length, nextCursor - offset);
      if (end > start) {
        slices.push(part.subarray(start, end));
      }
      offset += part.length;
      if (offset >= nextCursor) {
        break;
      }
    }
    const complete = nextCursor === content.descriptor.totalBytes;
    const result = ContentChunkSchema.parse({
      cursor: parsed.cursor,
      nextCursor,
      complete,
      data: Buffer.concat(slices).toString('base64'),
    });
    content.cursor = nextCursor;
    if (complete) {
      this.remove(parsed.capabilityId);
    }
    return result;
  }

  release(input: ContentIdentity): void {
    const parsed = input;
    if (this.retained.has(parsed.capabilityId)) {
      this.resolve(parsed);
      this.remove(parsed.capabilityId);
    }
  }

  close(): void {
    this.closed = true;
    for (const id of this.retained.keys()) {
      this.remove(id);
    }
  }

  private resolve(input: ContentIdentity): RetainedContent {
    this.expire();
    const content = this.retained.get(input.capabilityId);
    if (
      this.closed ||
      !content ||
      input.epoch !== this.epoch ||
      input.kind !== content.descriptor.kind ||
      input.resourceId !== content.descriptor.resourceId
    ) {
      throw new DiagnosticContentError();
    }
    return content;
  }

  private expire(): void {
    for (const [id, content] of this.retained) {
      if (content.descriptor.expiresAt <= this.now()) {
        this.remove(id);
      }
    }
  }

  private remove(id: string): void {
    const content = this.retained.get(id);
    if (content) {
      clearTimeout(content.timer);
      this.retainedBytes -= content.descriptor.totalBytes;
      this.retained.delete(id);
    }
  }
}
