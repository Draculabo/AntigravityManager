import type {
  TrafficAuditListInput,
  TrafficAuditListResult,
  TrafficAuditSummary,
} from '../audit/traffic-audit.types';

const header =
  'request_id,started_at,method,protocol,requested_model,actual_model,account_id,http_status,outcome,duration_ms,attempts,input_tokens,output_tokens\r\n';
const maxBytes = 8 * 1024 * 1024;
const pageSize = 100;

function csvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) {
    return '';
  }
  if (typeof value === 'number') {
    return String(value);
  }
  const safe = /^\s*[=+@-]|^[\r\n\t]/u.test(value) ? `'${value}` : value;
  return `"${safe.replaceAll('"', '""')}"`;
}

function csvRow(row: TrafficAuditSummary) {
  return (
    [
      row.id,
      new Date(row.timestamp).toISOString(),
      row.method,
      row.protocol,
      row.model,
      row.physicalModel,
      row.attributedAccountId,
      row.status,
      row.outcome,
      row.durationMs,
      row.attemptCount,
      row.inputTokens,
      row.outputTokens,
    ]
      .map(csvCell)
      .join(',') + '\r\n'
  );
}

export async function readTrafficRequestCsv(
  read: (input: TrafficAuditListInput) => Promise<TrafficAuditListResult>,
  input: TrafficAuditListInput,
  signal: AbortSignal,
): Promise<string[]> {
  const parts = [header];
  const encoder = new TextEncoder();
  const seen = new Set<string>();
  let size = header.length;
  let expected: number | undefined;
  const to = Math.min(input.to ?? Date.now(), Date.now());
  for (let offset = 0; expected === undefined || offset < expected; ) {
    signal.throwIfAborted();
    const page = await read({ ...input, to, offset, limit: pageSize });
    signal.throwIfAborted();
    expected ??= page.total;
    if (page.total !== expected || (page.items.length === 0 && offset < expected)) {
      throw new Error('traffic-change');
    }
    for (const row of page.items) {
      if (seen.has(row.id)) {
        throw new Error('traffic-change');
      }
      seen.add(row.id);
      const line = csvRow(row);
      size += encoder.encode(line).byteLength;
      if (size > maxBytes) {
        throw new Error('traffic-csv-size');
      }
      parts.push(line);
    }
    offset += page.items.length;
  }
  if (seen.size !== expected) {
    throw new Error('traffic-change');
  }
  return parts;
}
