import { z } from 'zod';

/** Final success is per request; recovered upstream failures remain visible in the proof. */
export function clientUpstreamPasses(requests, expectedRequestCount) {
  return (
    requests.length === expectedRequestCount &&
    requests.length >= 2 &&
    requests.every(
      (request) =>
        request.attempts.length > 0 &&
        request.attempts.every((attempt) => attempt.model === 'gemini-3.7-flash-high') &&
        request.attempts.at(-1).status === 200,
    )
  );
}

export function readClientMatrixUpstream(database, trace) {
  const rows = z
    .array(
      z.object({
        parentId: z.string(),
        headers: z.string(),
        model: z.string().nullable(),
        status: z.number().nullable(),
      }),
    )
    .parse(
      database
        .prepare(
          'SELECT l.id AS parentId,l.request_headers AS headers,a.model,a.status FROM request_logs l JOIN upstream_attempts a ON a.parent_id=l.id WHERE l.request_headers LIKE ? ORDER BY l.timestamp,a.attempt_index LIMIT 128',
        )
        .all(`%${trace}:multi-client:%`),
    );
  const groups = new Map();
  for (const row of rows) {
    const headers = z.record(z.string(), z.unknown()).parse(JSON.parse(row.headers));
    const value = Object.entries(headers).find(
      ([name]) => name.toLowerCase() === 'x-schema-acceptance',
    )?.[1];
    const prefix = `${trace}:multi-client:`;
    const client = z
      .enum(['codex', 'opencode', 'claude'])
      .parse(
        typeof value === 'string' && value.startsWith(prefix)
          ? value.slice(prefix.length)
          : undefined,
      );
    let group = groups.get(row.parentId);
    if (!group) {
      group = {
        client,
        requestOrdinal: [...groups.values()].filter((item) => item.client === client).length + 1,
        attempts: [],
      };
      groups.set(row.parentId, group);
    }
    group.attempts.push({
      model: row.model === 'gemini-3.7-flash-high' ? row.model : 'other',
      status: row.status,
    });
  }
  return [...groups.values()];
}
