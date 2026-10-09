import { z } from 'zod';

export function retryEvidencePasses(mode, evidence) {
  const attempts = evidence.attempts;
  const statuses = attempts.map((attempt) => attempt.status);
  const roles = attempts.map((attempt) => attempt.role);
  const outcomes = attempts.map((attempt) => attempt.outcome);
  if (
    !evidence.singleGatewayRequest ||
    attempts.some((attempt) => attempt.accountOrdinal === null)
  ) {
    return false;
  }
  if (mode === 'network') {
    return (
      JSON.stringify(statuses) === '[null,200]' &&
      JSON.stringify(roles) === '["primary","backup"]' &&
      JSON.stringify(outcomes) === '["upstream_error","completed"]' &&
      evidence.distinctAccounts === 1
    );
  }
  if (mode === 'incomplete') {
    return (
      JSON.stringify(statuses) === '[200,200]' &&
      JSON.stringify(roles) === '["primary","primary"]' &&
      JSON.stringify(outcomes) === '["completed","completed"]' &&
      JSON.stringify(attempts.map((attempt) => attempt.operation)) ===
        '["generate-content","stream-generate"]' &&
      evidence.distinctAccounts === 1
    );
  }
  return (
    mode === 'rotation' &&
    JSON.stringify(statuses) === '[503,503,200]' &&
    JSON.stringify(roles) === '["primary","backup","primary"]' &&
    JSON.stringify(outcomes) === '["upstream_error","upstream_error","completed"]' &&
    evidence.distinctAccounts === 2 &&
    attempts[0].accountOrdinal === attempts[1].accountOrdinal &&
    attempts[1].accountOrdinal !== attempts[2].accountOrdinal
  );
}

/** Resolve identities only in memory and export ordinals scoped to one gateway request. */
export function readLiveRetryEvidence(database, trace, mode, label = 'history-combined-result') {
  const rows = z
    .array(
      z.object({
        parentId: z.string(),
        accountIdentity: z.string().nullable(),
        endpoint: z.string(),
        operation: z.string(),
        status: z.number().nullable(),
        outcome: z.string(),
      }),
    )
    .parse(
      database
        .prepare(
          'SELECT a.parent_id AS parentId, COALESCE(a.account_id_hash,a.account_id) AS accountIdentity,a.endpoint,a.operation,a.status,a.outcome FROM upstream_attempts a JOIN request_logs l ON l.id=a.parent_id WHERE l.request_headers LIKE ? ORDER BY a.attempt_index LIMIT 32',
        )
        .all(`%${trace}:${mode}:${label}%`),
    );
  const identities = new Map();
  const attempts = rows.map((row) => {
    let accountOrdinal = null;
    if (row.accountIdentity) {
      if (!identities.has(row.accountIdentity)) {
        identities.set(row.accountIdentity, identities.size + 1);
      }
      accountOrdinal = identities.get(row.accountIdentity);
    }
    const url = new URL(row.endpoint);
    const role =
      url.hostname === '127.0.0.1' && url.pathname.startsWith('/primary/')
        ? 'primary'
        : url.hostname === '127.0.0.1' && url.pathname.startsWith('/backup/')
          ? 'backup'
          : 'other';
    return {
      operation: ['generate-content', 'stream-generate'].includes(row.operation)
        ? row.operation
        : 'other',
      accountOrdinal,
      role,
      status: row.status,
      outcome: ['completed', 'upstream_error'].includes(row.outcome) ? row.outcome : 'other',
    };
  });
  return {
    singleGatewayRequest: new Set(rows.map((row) => row.parentId)).size === 1,
    distinctAccounts: identities.size,
    attempts,
  };
}
