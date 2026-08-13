import {
  isTerminalBatchStatus,
  type BatchJobRecord,
  type BatchRequestError,
  type BatchRequestRecord,
} from './batch-job.types';

/**
 * Every state change a batch record can undergo, as plain functions over the
 * record.
 *
 * They live apart from {@link BatchRunnerService} because they are the part
 * worth reading on its own: what a restart does to an interrupted request, what
 * cancellation does to one that has not started, and what expiry does to one
 * that never ran. The service owns scheduling, persistence and concurrency;
 * these own the meaning. Each mutating function documents what it changed so
 * the caller knows when a write is owed.
 */

/**
 * Resets whatever the last process had in flight.
 *
 * Anything the store says was `running` cannot have finished -- the outcome is
 * written before the state leaves `running` -- so it goes back to `pending` and
 * is retried from the top by the new process.
 */
export function resetInterruptedRequests(job: BatchJobRecord): boolean {
  if (isTerminalBatchStatus(job.status)) {
    return false;
  }
  let changed = false;
  for (const request of job.requests) {
    if (request.state === 'running') {
      request.state = 'pending';
      delete request.startedAtMs;
      changed = true;
    }
  }
  return changed;
}

/**
 * Cancels every request that has not been dispatched.
 *
 * One already in flight is left alone: the cost is already incurred and the
 * connection cannot be un-sent. Its answer is discarded when it arrives, which
 * is why the batch sits in `cancelling` until then.
 */
export function beginCancellation(job: BatchJobRecord, now: number): void {
  job.status = 'cancelling';
  job.cancellingAtMs = now;
  for (const request of job.requests) {
    if (request.state === 'pending') {
      request.state = 'canceled';
      request.finishedAtMs = now;
    }
  }
}

/**
 * Marks a batch that outlived its completion window.
 *
 * Requests that never ran are `expired`; the ones that did keep their real
 * outcome, because they really did cost what they cost.
 */
export function applyBatchExpiry(job: BatchJobRecord, now: number): boolean {
  if (isTerminalBatchStatus(job.status) || now < job.expiresAtMs) {
    return false;
  }
  for (const request of job.requests) {
    if (request.state === 'pending' || request.state === 'running') {
      request.state = 'expired';
      request.finishedAtMs = now;
    }
  }
  job.status = 'expired';
  job.expiredAtMs = now;
  return true;
}

/** Claims the next pending request for execution, moving the batch out of `validating`. */
export function claimRequest(job: BatchJobRecord, request: BatchRequestRecord, now: number): void {
  request.state = 'running';
  request.startedAtMs = now;
  if (job.status === 'validating') {
    job.status = 'in_progress';
    job.inProgressAtMs = now;
  }
}

/**
 * Records one request's outcome against its `custom_id`.
 * A failure is data, not an abort: the batch keeps going either way.
 */
export function recordRequestOutcome(
  job: BatchJobRecord,
  request: BatchRequestRecord,
  result:
    | { outcome: 'succeeded'; response: unknown }
    | { outcome: 'errored'; error: BatchRequestError },
  now: number,
): void {
  request.finishedAtMs = now;
  if (job.status === 'cancelling') {
    // The answer arrived after the client asked to stop; it is not reported.
    request.state = 'canceled';
    delete request.response;
    return;
  }
  if (result.outcome === 'succeeded') {
    request.state = 'succeeded';
    request.response = result.response;
    return;
  }
  request.state = 'errored';
  request.error = result.error;
}

/** Closes a batch that has nothing left to run, in the way it was heading. */
export function endBatch(job: BatchJobRecord, wasCancelling: boolean, now: number): void {
  if (wasCancelling) {
    job.status = 'cancelled';
    job.cancelledAtMs = now;
    return;
  }
  job.status = 'completed';
  job.completedAtMs = now;
}
