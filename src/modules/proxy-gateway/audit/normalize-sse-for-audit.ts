import { reconstructAuditSseResponse } from './traffic-audit-sse-reconstruction';

/** Reconstruct a readable response for diagnostic input; malformed SSE stays unchanged. */
export function normalizeSseForAudit(raw: string): unknown {
  if (!raw.includes('data:')) {
    return raw;
  }
  const events: unknown[] = [];
  for (const line of raw.split(/\r?\n/gu)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) {
      continue;
    }
    const data = trimmed.slice(5).trim();
    if (!data || data === '[DONE]') {
      continue;
    }
    try {
      events.push(JSON.parse(data));
    } catch {
      return raw;
    }
  }
  return { response: reconstructAuditSseResponse(events), stream: true };
}
