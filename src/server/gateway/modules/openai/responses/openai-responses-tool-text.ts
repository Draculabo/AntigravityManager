import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { PrivateContentStore } from '../../files/files.service';
import { extractToolResultImages } from '../../../../../modules/proxy-gateway/antigravity/MarkdownImageParts';

const CHUNK_BYTES = 16 * 1024 * 1024;
const MAX_TEXT_BYTES = 4 * CHUNK_BYTES;
const referenceSchema = z
  .object({
    __agm_responses_media_reference: z.literal(2),
    encoding: z.literal('json-text'),
    ids: z
      .array(z.string().regex(/^[a-f0-9]{32}$/u))
      .min(1)
      .max(4),
    bytes: z.number().int().min(1).max(MAX_TEXT_BYTES),
    sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict();

export type ResponsesToolTextReference = z.infer<typeof referenceSchema>;

export function isValidToolTextReference(value: unknown): value is ResponsesToolTextReference {
  return referenceSchema.safeParse(value).success;
}

export function containsToolTextImage(value: unknown): boolean {
  return typeof value === 'string' && extractToolResultImages(value).media.length > 0;
}

/** Store exact text, rather than a rewritten extraction view used only for sending. */
export async function storeResponsesToolText(
  value: string,
  content: PrivateContentStore,
): Promise<ResponsesToolTextReference> {
  if (Buffer.byteLength(value, 'utf8') > MAX_TEXT_BYTES - 2) {
    throw new Error('Image-bearing tool text exceeds the 64 MiB private storage limit');
  }
  // JSON encoding preserves lone surrogates and original JSON/Markdown spelling.
  const encoded = JSON.stringify(value);
  const bytes = Buffer.byteLength(encoded, 'utf8');
  if (bytes > MAX_TEXT_BYTES) {
    throw new Error('Image-bearing tool text exceeds the 64 MiB private storage limit');
  }
  const input = Buffer.from(encoded, 'utf8');
  const ids: string[] = [];
  for (let offset = 0; offset < bytes; offset += CHUNK_BYTES) {
    ids.push(await content.put(input.subarray(offset, offset + CHUNK_BYTES), 'application/json'));
  }
  return {
    __agm_responses_media_reference: 2,
    encoding: 'json-text',
    ids,
    bytes,
    sha256: createHash('sha256').update(input).digest('hex'),
  };
}

export async function restoreResponsesToolText(
  value: unknown,
  content: PrivateContentStore,
): Promise<string> {
  const ref = referenceSchema.parse(value);
  if (ref.ids.length !== Math.ceil(ref.bytes / CHUNK_BYTES)) {
    throw new Error('Invalid private tool text chunk count');
  }
  const chunks: Buffer[] = [];
  let read = 0;
  for (const id of ref.ids) {
    const chunk = await content.get(id);
    if (chunk.length !== Math.min(CHUNK_BYTES, ref.bytes - read)) {
      throw new Error('Invalid private tool text chunk size');
    }
    chunks.push(chunk);
    read += chunk.length;
  }
  const input = Buffer.concat(chunks, ref.bytes);
  if (createHash('sha256').update(input).digest('hex') !== ref.sha256) {
    throw new Error('Private tool text fingerprint changed');
  }
  const text: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(input));
  if (typeof text !== 'string') {
    throw new Error('Private tool text must decode to a string');
  }
  return text;
}
