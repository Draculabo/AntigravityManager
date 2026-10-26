import zlib from 'node:zlib';
const RAW_MAGIC = Buffer.from('RAW1');
const GZIP_MAGIC = Buffer.from('AGZ1');
const MIN_GZIP_BYTES = 384;
export function packThought(text: string): Buffer {
  const raw = Buffer.from(text, 'utf8');
  if (raw.length >= MIN_GZIP_BYTES) {
    const compressed = zlib.gzipSync(raw, { level: zlib.constants.Z_BEST_SPEED });
    if (compressed.length + GZIP_MAGIC.length < raw.length) {
      return Buffer.concat([GZIP_MAGIC, compressed]);
    }
  }
  return Buffer.concat([RAW_MAGIC, raw]);
}

export function unpackThought(
  value: Buffer | null,
  recordId: number,
  maxBytes = 64 * 1024 * 1024,
): string {
  if (!value) {
    return '';
  }
  if (value.subarray(0, 4).equals(GZIP_MAGIC)) {
    try {
      const decoded = zlib.gunzipSync(value.subarray(4), {
        maxOutputLength: Math.max(1, maxBytes),
      });
      if (decoded.length > maxBytes) {
        throw new RangeError('Thought Store decode budget exceeded');
      }
      return decoded.toString('utf8');
    } catch (error) {
      if (
        (error instanceof RangeError && error.message === 'Thought Store decode budget exceeded') ||
        (error &&
          typeof error === 'object' &&
          Reflect.get(error, 'code') === 'ERR_BUFFER_TOO_LARGE')
      ) {
        throw new Error(`Thought Store record ${recordId} exceeds decode budget`, { cause: error });
      }
      const reason = error instanceof Error ? error.message : 'decompression failed';
      throw new Error(`Thought Store record ${recordId} contains invalid gzip data: ${reason}`, {
        cause: error,
      });
    }
  }
  if (value.subarray(0, 4).equals(RAW_MAGIC)) {
    if (value.length - RAW_MAGIC.length > maxBytes) {
      throw new Error(`Thought Store record ${recordId} exceeds decode budget`);
    }
    return value.subarray(4).toString('utf8');
  }
  if (value.length > maxBytes) {
    throw new Error(`Thought Store record ${recordId} exceeds decode budget`);
  }
  return value.toString('utf8');
}
