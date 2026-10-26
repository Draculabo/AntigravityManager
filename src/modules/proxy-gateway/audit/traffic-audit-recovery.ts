import type Database from 'better-sqlite3';

/** Reconcile capture lifetime, without claiming the provider completed or failed. */
export function recoverInterruptedAudit(database: Database.Database, ownerStartedAt: number): void {
  database.transaction(() => {
    const recoveredAt = Date.now();
    for (const table of ['request_logs', 'upstream_attempts'] as const) {
      database
        .prepare(
          `UPDATE ${table} SET completed_at=?,response_partial=1 ` +
            "WHERE outcome='in_progress' AND completed_at IS NULL AND timestamp<?",
        )
        .run(recoveredAt, ownerStartedAt);
    }
    database
      .prepare(
        "UPDATE audit_payloads SET state='incomplete',partial=1," +
          "dropped_reason=COALESCE(dropped_reason,'worker_restart')," +
          'stored_bytes=COALESCE((SELECT SUM(byte_length) FROM audit_payload_chunks ' +
          'WHERE payload_id=audit_payloads.id),0),chunk_count=(SELECT COUNT(*) FROM ' +
          "audit_payload_chunks WHERE payload_id=audit_payloads.id),completed_at=? WHERE state='writing' AND created_at<?",
      )
      .run(recoveredAt, ownerStartedAt);
  })();
}

export function auditCaptureOutcome(outcome: string, completedAt: number | null): string {
  return outcome === 'in_progress' && completedAt !== null ? 'capture_interrupted' : outcome;
}
