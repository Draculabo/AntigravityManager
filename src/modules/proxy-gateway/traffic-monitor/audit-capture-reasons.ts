const REASONS = new Map([
  ['audit_disk_budget', 'disk-budget'],
  ['audit_disk_usage_unknown', 'disk-unknown'],
  ['audit_checkpoint_busy', 'checkpoint-busy'],
  ['audit_reclaim_failed', 'reclaim-failed'],
  ['audit_read_only', 'read-only'],
  ['audit_disk_full', 'disk-full'],
  ['capture_disabled', 'capture-disabled'],
  ['worker_restart', 'worker-restart'],
  ['retention', 'retention'],
  ['disk_pressure', 'disk-pressure'],
  ['body_chunk_queue_or_write_failure', 'write-failure'],
  ['sse_chunk_queue_or_write_failure', 'write-failure'],
  ['worker_write_failure', 'write-failure'],
  ['ipc_payload_transfer_incomplete', 'transfer-incomplete'],
  ['body_serialization_failure', 'serialization-failure'],
]);
/** Persisted/private reason strings never become UI copy. */
export function auditCaptureReasonKey(reason: string | null | undefined): string {
  return `traffic.capture.reasons.${reason ? (REASONS.get(reason) ?? 'unknown') : 'unknown'}`;
}
