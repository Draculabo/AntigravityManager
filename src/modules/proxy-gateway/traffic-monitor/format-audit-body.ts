import type { TrafficAuditBodyDescriptor } from '@/modules/proxy-gateway/audit/traffic-audit.types';

const MAX_FORMATTED_CHARACTERS = 8 * 1024 * 1024;
const CONCISE_KEYS = [
  'id',
  'object',
  'model',
  'created',
  'status',
  'error',
  'usage',
  'choices',
  'response',
  'candidates',
  'usageMetadata',
  'modelVersion',
  'responseId',
  'traceId',
  'metadata',
] as const;

/** Formats only the bounded editor window; audit storage and full-body export remain unchanged. */
export function formatAuditBody(
  content: string,
  kind: TrafficAuditBodyDescriptor['kind'],
  mode: 'concise' | 'full',
): string {
  const trimmed = content.trimStart();
  if (
    !trimmed ||
    (kind !== 'json' && kind !== 'text') ||
    (kind === 'text' && !trimmed.startsWith('{') && !trimmed.startsWith('['))
  ) {
    return content;
  }
  try {
    const parsed: unknown = JSON.parse(content);
    let display: unknown = parsed;
    if (mode === 'concise' && parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const source = parsed as Record<string, unknown>;
      const concise: Record<string, unknown> = {};
      for (const key of CONCISE_KEYS) {
        if (Object.hasOwn(source, key)) {
          concise[key] = source[key];
        }
      }
      if (Object.keys(concise).length > 0) {
        display = concise;
      }
    }
    const formatted = JSON.stringify(display, null, 2);
    return formatted && formatted.length <= MAX_FORMATTED_CHARACTERS ? formatted : content;
  } catch {
    // Incomplete windows and malformed payloads must stay byte-for-byte readable.
    return content;
  }
}
