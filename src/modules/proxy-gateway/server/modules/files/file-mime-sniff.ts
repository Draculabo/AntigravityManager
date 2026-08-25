/**
 * Magic-byte MIME sniffing for uploaded content.
 *
 * The declared MIME type is a client claim. The upstream `generateContent`
 * call rejects a mislabelled `inlineData` part, and it does so at generation
 * time with an opaque provider error. Sniffing at upload time means the
 * mismatch is corrected once, where the client can still see it, instead of
 * surfacing later as a confusing failure on an unrelated request.
 */

interface MagicSignature {
  mimeType: string;
  offset: number;
  bytes: number[];
  /** Extra check for containers whose first bytes are not unique enough. */
  verify?: (buffer: Buffer) => boolean;
}

const SIGNATURES: MagicSignature[] = [
  { mimeType: 'image/png', offset: 0, bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { mimeType: 'image/jpeg', offset: 0, bytes: [0xff, 0xd8, 0xff] },
  { mimeType: 'image/gif', offset: 0, bytes: [0x47, 0x49, 0x46, 0x38] },
  { mimeType: 'image/bmp', offset: 0, bytes: [0x42, 0x4d] },
  {
    mimeType: 'image/webp',
    offset: 0,
    bytes: [0x52, 0x49, 0x46, 0x46],
    verify: (buffer) => buffer.subarray(8, 12).toString('latin1') === 'WEBP',
  },
  {
    mimeType: 'audio/wav',
    offset: 0,
    bytes: [0x52, 0x49, 0x46, 0x46],
    verify: (buffer) => buffer.subarray(8, 12).toString('latin1') === 'WAVE',
  },
  { mimeType: 'application/pdf', offset: 0, bytes: [0x25, 0x50, 0x44, 0x46, 0x2d] },
  { mimeType: 'audio/flac', offset: 0, bytes: [0x66, 0x4c, 0x61, 0x43] },
  { mimeType: 'audio/ogg', offset: 0, bytes: [0x4f, 0x67, 0x67, 0x53] },
  { mimeType: 'audio/mpeg', offset: 0, bytes: [0x49, 0x44, 0x33] },
  { mimeType: 'audio/mpeg', offset: 0, bytes: [0xff, 0xfb] },
  { mimeType: 'video/mp4', offset: 4, bytes: [0x66, 0x74, 0x79, 0x70] },
  { mimeType: 'application/gzip', offset: 0, bytes: [0x1f, 0x8b] },
  { mimeType: 'application/zip', offset: 0, bytes: [0x50, 0x4b, 0x03, 0x04] },
];

function matches(buffer: Buffer, signature: MagicSignature): boolean {
  const end = signature.offset + signature.bytes.length;
  if (buffer.length < end) {
    return false;
  }
  for (let index = 0; index < signature.bytes.length; index += 1) {
    if (buffer[signature.offset + index] !== signature.bytes[index]) {
      return false;
    }
  }
  return signature.verify ? signature.verify(buffer) : true;
}

/**
 * Returns the MIME type the bytes themselves declare, or `null` when the
 * content carries no signature this proxy recognises. `null` is not "unknown
 * content is bad" — it means the declared type is the only evidence available
 * and is kept as-is.
 */
export function sniffMimeType(buffer: Buffer): string | null {
  for (const signature of SIGNATURES) {
    if (matches(buffer, signature)) {
      return signature.mimeType;
    }
  }
  if (looksLikeUtf8Text(buffer)) {
    return looksLikeJson(buffer) ? 'application/json' : 'text/plain';
  }
  return null;
}

/**
 * Chooses the type the store will carry. Sniffed evidence wins over a client
 * claim whenever the bytes were recognised, because the provider validates the
 * bytes, not the label.
 *
 * The one exception is a recognised *text* payload: `text/plain` is what
 * anything UTF-8 sniffs as, so a client declaring `text/markdown`,
 * `text/csv` or `application/xml` keeps its more specific — and still
 * truthful — label.
 */
export function resolveEffectiveMimeType(
  declared: string | undefined,
  sniffed: string | null,
): string {
  const normalizedDeclared = normalizeMimeType(declared);
  if (!sniffed) {
    return normalizedDeclared ?? 'application/octet-stream';
  }
  if (!normalizedDeclared) {
    return sniffed;
  }
  if (normalizedDeclared === sniffed) {
    return sniffed;
  }
  if (isTextLike(sniffed) && isTextLike(normalizedDeclared)) {
    return normalizedDeclared;
  }
  return sniffed;
}

export function normalizeMimeType(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const withoutParameters = value.split(';')[0]?.trim().toLowerCase();
  return withoutParameters || undefined;
}

function isTextLike(mimeType: string): boolean {
  return (
    mimeType.startsWith('text/') ||
    mimeType === 'application/json' ||
    mimeType === 'application/xml' ||
    mimeType.endsWith('+json') ||
    mimeType.endsWith('+xml')
  );
}

function looksLikeUtf8Text(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, Math.min(buffer.length, 4096));
  if (sample.length === 0) {
    return false;
  }
  for (const byte of sample) {
    // Control characters other than tab, newline and carriage return mean binary.
    if (byte < 0x09 || (byte > 0x0d && byte < 0x20)) {
      return false;
    }
  }
  return Buffer.from(sample.toString('utf8'), 'utf8').equals(sample);
}

function looksLikeJson(buffer: Buffer): boolean {
  const text = buffer.subarray(0, Math.min(buffer.length, 4096)).toString('utf8').trimStart();
  return text.startsWith('{') || text.startsWith('[');
}
