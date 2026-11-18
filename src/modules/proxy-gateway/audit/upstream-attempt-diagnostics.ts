import { randomUUID } from 'node:crypto';
import { errorProcessOwner } from '@/modules/error-diagnostics/public';
import { UpstreamGenerationError } from '../antigravity/UpstreamGenerationError';
import { classifyTransportError } from '../antigravity/stream-error-utils';
import { UpstreamRequestError } from '../../../server/gateway/common/exceptions/upstream-request.exception';
import type { UpstreamAttemptHandle } from './traffic-audit.service';
import type { CompleteUpstreamAttemptInput } from './traffic-audit.types';
import { isFailedAuditAttempt } from './audit-attempt-outcome';
import { extractAuditUsage, mergeAuditUsage, type AuditUsage } from './audit-usage';
import { parseAuditJsonBody } from './audit-json-object';
import { IncrementalSseRedactor } from './incremental-sse-redactor';
import type { StartUpstreamAttemptInput } from './traffic-audit.types';

/** One actual physical send; an absent audit handle does not create an audit row. */
export interface CurrentUpstreamAttemptHandle {
  readonly audit: UpstreamAttemptHandle | null;
  readonly id: string;
  readonly operation: string;
  readonly requestId?: string;
  readonly accountId?: string;
  readonly accountGenerationHash?: string;
  readonly model?: string;
  readonly usageScope?: StartUpstreamAttemptInput['usageScope'];
}

const completed = new WeakSet<CurrentUpstreamAttemptHandle>();
const attemptUsage = new WeakMap<CurrentUpstreamAttemptHandle, AuditUsage>();
const incompleteUsage = new WeakSet<CurrentUpstreamAttemptHandle>();

/** Observe the physical response before semantic rejection or cancellation can hide its usage. */
export function captureUpstreamAttemptUsage(
  handle: CurrentUpstreamAttemptHandle | null,
  value: unknown,
): void {
  if (!handle || completed.has(handle)) {
    return;
  }
  const parsed = parseAuditJsonBody(value);
  let observed = extractAuditUsage(parsed);
  if (parsed === undefined && typeof value === 'string' && /(^|[\r\n])data:/.test(value)) {
    const parser = new IncrementalSseRedactor({
      onRawParsedEvent: (event) => {
        observed = mergeAuditUsage(observed, extractAuditUsage(event));
      },
    });
    parser.push(value);
    const final = parser.finish();
    if (final.result.parseErrorOffset !== null || final.result.errorSummary !== null) {
      incompleteUsage.add(handle);
    }
  }
  const usage = mergeAuditUsage(attemptUsage.get(handle), observed);
  if (usage) {
    attemptUsage.set(handle, usage);
  }
}

export function currentUpstreamAttemptUsage(
  handle: CurrentUpstreamAttemptHandle | null,
): AuditUsage | undefined {
  return handle ? attemptUsage.get(handle) : undefined;
}

export function isUpstreamAttemptUsagePartial(handle: CurrentUpstreamAttemptHandle | null): boolean {
  return handle !== null && incompleteUsage.has(handle);
}

export function createCurrentUpstreamAttempt(
  audit: UpstreamAttemptHandle | null,
  operation: string,
  requestId?: string,
  identity?: Pick<StartUpstreamAttemptInput, 'accountId' | 'accountGenerationHash' | 'model' | 'usageScope'>,
): CurrentUpstreamAttemptHandle {
  return Object.freeze({
    audit,
    id: audit?.id ?? randomUUID(),
    operation,
    requestId,
    accountId: identity?.accountId,
    accountGenerationHash: identity?.accountGenerationHash,
    model: identity?.model,
    usageScope: identity?.usageScope,
  });
}

/** Completion is once-only across stream close/error and unary catch paths. */
export function completeUpstreamAttemptDiagnostic(
  handle: CurrentUpstreamAttemptHandle,
  input: CompleteUpstreamAttemptInput,
): boolean {
  if (completed.has(handle) || input.outcome === 'in_progress') {
    return false;
  }
  completed.add(handle);
  const error = input.error instanceof Error ? input.error : undefined;
  const code: unknown = error ? Reflect.get(error, 'code') : undefined;
  const transport =
    error instanceof UpstreamRequestError
      ? error.transportFailure
      : error
        ? classifyTransportError(error)
        : undefined;
  const cancelled =
    error?.name === 'AbortError' ||
    code === 'ERR_CANCELED' ||
    code === 'ABORT_ERR' ||
    (error instanceof UpstreamRequestError && error.transportFailure === 'cancelled');
  if (
    !isFailedAuditAttempt(input) ||
    input.outcome === 'client_cancelled' ||
    input.outcome === 'client_disconnected' ||
    cancelled
  ) {
    return true;
  }
  const category =
    error instanceof UpstreamGenerationError
      ? error.code
      : input.status === 401 || input.status === 403
        ? 'authorization_failure'
        : input.status === 429
          ? 'rate_limited'
          : ((transport === 'cancelled' ? undefined : transport) ?? 'upstream_error');
  try {
    errorProcessOwner.capture({
      error:
        error ??
        `Upstream attempt ended with ${input.status === undefined ? input.outcome : `HTTP ${input.status}`}.`,
      source: 'proxy-gateway',
      module: 'google-transport',
      functionName: handle.operation,
      stage: 'upstream-attempt',
      protocol: 'google',
      category,
      status: input.status,
      requestId: handle.requestId,
      attemptId: handle.id,
    });
  } catch {
    // A diagnostic sink must not change the original attempt or recursively log itself.
  }
  return true;
}
