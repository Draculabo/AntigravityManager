import type { TrafficAuditBodyDescriptor } from '@/modules/proxy-gateway/audit/traffic-audit.types';

const MAX_FORMATTED_CHARACTERS = 8 * 1024 * 1024;

function omitMediaLeaves(value: unknown, container?: string, parentType?: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => omitMediaLeaves(entry));
  }
  if (!value || typeof value !== 'object') {
    return value;
  }
  const source = value as Record<string, unknown>;
  const inlineMedia =
    ((container === 'inlineData' || container === 'inline_data') &&
      (typeof source.mimeType === 'string' || typeof source.mime_type === 'string')) ||
    (container === 'source' && source.type === 'base64' && typeof source.media_type === 'string') ||
    (container === 'input_audio' &&
      parentType === 'input_audio' &&
      typeof source.format === 'string') ||
    (container === 'audio' &&
      typeof source.id === 'string' &&
      typeof source.expires_at === 'number');
  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(source)) {
    const mediaUrl =
      ((container === 'image_url' && parentType === 'image_url' && key === 'url') ||
        (source.type === 'input_image' && key === 'image_url')) &&
      typeof entry === 'string' &&
      /^data:(?:image|audio|video)\/[^;,]+;base64,/iu.test(entry);
    const inlineFile =
      source.type === 'input_file' &&
      key === 'file_data' &&
      typeof entry === 'string' &&
      /^data:[^;,]+;base64,/iu.test(entry);
    if (typeof entry === 'string' && ((inlineMedia && key === 'data') || mediaUrl || inlineFile)) {
      Object.defineProperty(output, key, {
        value: `[omitted media data: ${new TextEncoder().encode(entry).byteLength} UTF-8 bytes; concise view]`,
        enumerable: true,
      });
      continue;
    }
    // JSON field names remain data, including the special JavaScript setter name.
    Object.defineProperty(output, key, {
      value: omitMediaLeaves(entry, key, source.type),
      enumerable: true,
    });
  }
  return output;
}
/** Formats only the bounded editor window; audit storage and full-body export remain unchanged. */
export function formatAuditBody(
  content: string,
  kind: TrafficAuditBodyDescriptor['kind'],
  mode: 'concise' | 'full',
): string {
  const trimmed = content.trimStart();
  if (
    !trimmed ||
    content.length > MAX_FORMATTED_CHARACTERS ||
    (kind !== 'json' && kind !== 'text') ||
    (kind === 'text' && !trimmed.startsWith('{') && !trimmed.startsWith('['))
  ) {
    return content;
  }
  try {
    const parsed: unknown = JSON.parse(content);
    const display = mode === 'concise' ? omitMediaLeaves(parsed) : parsed;
    const formatted = JSON.stringify(display, null, 2);
    return formatted && formatted.length <= MAX_FORMATTED_CHARACTERS ? formatted : content;
  } catch {
    // Incomplete windows and malformed payloads must stay byte-for-byte readable.
    return content;
  }
}
