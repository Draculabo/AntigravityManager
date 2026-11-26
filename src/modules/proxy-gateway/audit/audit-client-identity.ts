import { z } from 'zod';
import { sql, type SQLWrapper } from 'drizzle-orm';

export const AuditClientSchema = z.enum([
  'claude-code',
  'codex',
  'opencode',
  'gemini-cli',
  'antigravity',
  'curl',
]);

/** Group known client agents without returning the raw request header. */
export function observedAuditClient(headers: SQLWrapper) {
  const agent = sql`lower(CASE WHEN json_valid(${headers}) THEN json_extract(${headers},'$."user-agent"') END)`;
  return sql<string | null>`CASE
    WHEN ${agent} LIKE '%claude-code%' OR ${agent} LIKE '%claude-cli%' THEN 'claude-code'
    WHEN ${agent} LIKE '%codex%' THEN 'codex'
    WHEN ${agent} LIKE '%opencode%' THEN 'opencode'
    WHEN ${agent} LIKE '%gemini-cli%' THEN 'gemini-cli'
    WHEN ${agent} LIKE '%antigravity%' THEN 'antigravity'
    WHEN ${agent} LIKE 'curl/%' THEN 'curl'
  END`;
}
