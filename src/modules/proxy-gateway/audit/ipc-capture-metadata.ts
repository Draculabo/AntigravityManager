import type { IpcCaptureMetadataAppendSchema } from './ipc-capture.schema';
import type { z } from 'zod';
import { MAX_AUDIT_BODY_BYTES } from './audit-sanitizer';
import { AUDIT_BODY_CHUNK_BYTES } from './incremental-audit-serializer';

type Field = z.infer<typeof IpcCaptureMetadataAppendSchema>['field'];
interface Value {
  pieces: string[];
  bytes: number;
  sequence: number;
  complete: boolean;
}

/** Shared by preparing metadata and a recorded failure; payload bodies use the SQLite writer. */
export class IpcCaptureMetadata {
  private readonly fields = new Map<Field, Value>();
  private bytes = 0;
  constructor(private readonly reserve: (bytes: number) => void) {}

  append(input: z.infer<typeof IpcCaptureMetadataAppendSchema>): void {
    const value = this.fields.get(input.field) ?? {
      pieces: [],
      bytes: 0,
      sequence: 0,
      complete: false,
    };
    const bytes = Buffer.from(input.data, 'base64');
    const text = bytes.toString('utf8');
    if (
      value.complete ||
      value.sequence !== input.sequence ||
      bytes.toString('base64') !== input.data ||
      !Buffer.from(text, 'utf8').equals(bytes) ||
      bytes.length > AUDIT_BODY_CHUNK_BYTES ||
      value.bytes + bytes.length > MAX_AUDIT_BODY_BYTES
    ) {
      throw new Error('IPC capture metadata is unavailable');
    }
    this.reserve(bytes.length);
    this.bytes += bytes.length;
    value.bytes += bytes.length;
    value.sequence += 1;
    value.pieces.push(text);
    value.complete = input.complete;
    this.fields.set(input.field, value);
  }
  read(field: Field): string | null {
    const value = this.fields.get(field);
    if (!value) {
      return null;
    }
    if (!value.complete) {
      throw new Error('IPC capture metadata is incomplete');
    }
    const text = value.pieces.join('');
    value.pieces = [text];
    return text;
  }
  retain(values: { path: string; sessionId: string | null; model: string | null }): void {
    const parts = Object.entries(values).filter(
      (entry): entry is [Field, string] => entry[1] !== null,
    );
    const bytes = parts.map(([field, text]) => ({
      field,
      text,
      bytes: Buffer.byteLength(text, 'utf8'),
    }));
    if (bytes.some((part) => part.bytes > MAX_AUDIT_BODY_BYTES)) {
      throw new Error('IPC capture metadata is unavailable');
    }
    const total = bytes.reduce((sum, part) => sum + part.bytes, 0);
    this.reserve(total);
    this.bytes += total;
    for (const part of bytes) {
      this.fields.set(part.field, {
        pieces: [part.text],
        bytes: part.bytes,
        sequence: 0,
        complete: true,
      });
    }
  }
  release(): void {
    this.fields.clear();
    this.reserve(-this.bytes);
    this.bytes = 0;
  }
}
