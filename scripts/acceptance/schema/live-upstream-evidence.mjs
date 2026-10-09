import { z } from 'zod';

export function hasVerifiedSignatureRecovery(upstreamModels) {
  const attempts = upstreamModels.filter(
    (attempt) => attempt.label === 'history-corruptedSignature-result',
  );
  return (
    attempts.length === 2 &&
    attempts[0].status === 400 &&
    attempts[1].status === 200 &&
    attempts.every((attempt) => attempt.attemptCount === 2)
  );
}

/** Correlate attempt counts in memory; never export parent IDs or request headers. */
export function readLiveUpstreamEvidence(database, tracePrefix) {
  const rows = z
    .array(
      z.object({
        parentId: z.string(),
        requestHeaders: z.string().nullable(),
        requestedModel: z.string().nullable(),
        upstreamModel: z.string().nullable(),
        status: z.number().nullable(),
      }),
    )
    .parse(
      database
        .prepare(
          'SELECT l.id AS parentId,l.request_headers AS requestHeaders,l.model AS requestedModel,a.model AS upstreamModel,a.status FROM request_logs l JOIN upstream_attempts a ON a.parent_id=l.id WHERE l.request_headers LIKE ? ORDER BY a.timestamp',
        )
        .all(`%${tracePrefix}%`),
    );
  const attempts = new Map();
  for (const row of rows) {
    attempts.set(row.parentId, (attempts.get(row.parentId) ?? 0) + 1);
  }
  const labels = new Set([
    'history-parallel-call',
    'history-combined-result',
    'history-split-result',
    'history-reversedResults-result',
    'history-resubmittedSameModel-result',
    'history-crossModel-result',
    'history-crossModelResubmitted-result',
    'history-corruptedSignature-result',
  ]);
  return rows.map((row) => {
    let label;
    try {
      const headers = z
        .record(z.string(), z.unknown())
        .parse(JSON.parse(row.requestHeaders ?? '{}'));
      const header = Object.entries(headers).find(
        ([name]) => name.toLowerCase() === 'x-schema-acceptance',
      )?.[1];
      if (typeof header === 'string' && header.startsWith(`${tracePrefix}:`)) {
        const candidate = header.slice(tracePrefix.length + 1);
        if (labels.has(candidate)) {
          label = candidate;
        }
      }
    } catch {
      // Missing or malformed audit headers cannot establish a scenario label.
    }
    return {
      requestedModel: row.requestedModel,
      upstreamModel: row.upstreamModel,
      status: row.status,
      attemptCount: attempts.get(row.parentId),
      ...(label ? { label } : {}),
    };
  });
}
