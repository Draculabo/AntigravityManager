import {
  BatchJobError,
  GEMINI_SERVABLE_BATCH_ACTION,
  countBatchRequests,
  isTerminalBatchStatus,
  type BatchJobRecord,
} from './batch-job.types';

export const GEMINI_BATCH_PREFIX = 'batches/';
const BATCH_METADATA_TYPE =
  'type.googleapis.com/google.ai.generativelanguage.v1beta.GenerateContentBatch';
const BATCH_RESPONSE_TYPE =
  'type.googleapis.com/google.ai.generativelanguage.v1beta.BatchGenerateContentResponse';

/**
 * The long-running-operation resource `:batchGenerateContent` answers with.
 *
 * Only the fields a poller actually needs are populated -- `name`,
 * `metadata`, `done` and exactly one of `response` / `error`. Nothing beyond
 * that is fabricated, because a local runner has no equivalent for most of
 * Google's batch bookkeeping.
 */
export interface GeminiOperationResource {
  name: string;
  metadata: Record<string, unknown>;
  done: boolean;
  response?: Record<string, unknown>;
  error?: { code: number; message: string; status: string };
}

export function toGeminiOperation(job: BatchJobRecord): GeminiOperationResource {
  const counts = countBatchRequests(job);
  const done = isTerminalBatchStatus(job.status);
  const operation: GeminiOperationResource = {
    name: `${GEMINI_BATCH_PREFIX}${job.id}`,
    metadata: {
      '@type': BATCH_METADATA_TYPE,
      model: job.endpoint.replace(/:generateContent$/u, ''),
      ...(job.displayName ? { displayName: job.displayName } : {}),
      state: toBatchState(job),
      createTime: new Date(job.createdAtMs).toISOString(),
      updateTime: new Date(lastChangeMs(job)).toISOString(),
      batchStats: {
        requestCount: String(counts.total),
        successfulRequestCount: String(counts.succeeded),
        failedRequestCount: String(counts.errored),
        pendingRequestCount: String(counts.processing),
      },
    },
    done,
  };

  if (!done) {
    return operation;
  }
  if (job.status === 'cancelled') {
    operation.error = { code: 1, message: `Batch ${job.id} was cancelled`, status: 'CANCELLED' };
    return operation;
  }
  if (job.status === 'expired' || job.status === 'failed') {
    operation.error = {
      code: 4,
      message: job.error?.message ?? `Batch ${job.id} ${job.status}`,
      status: job.status === 'expired' ? 'DEADLINE_EXCEEDED' : 'UNKNOWN',
    };
    return operation;
  }

  operation.response = {
    '@type': BATCH_RESPONSE_TYPE,
    inlinedResponses: {
      inlinedResponses: job.requests.map((request) =>
        request.state === 'succeeded'
          ? { metadata: { key: request.customId }, response: request.response }
          : {
              metadata: { key: request.customId },
              error: {
                code: request.error?.httpStatus ?? 500,
                message: request.error?.message ?? `Request ${request.state}`,
                status: request.state === 'expired' ? 'DEADLINE_EXCEEDED' : 'UNKNOWN',
              },
            },
      ),
    },
  };
  return operation;
}

/** Google's `BatchState` enum, mapped from the runner's own status. */
function toBatchState(job: BatchJobRecord): string {
  switch (job.status) {
    case 'validating':
      return 'BATCH_STATE_PENDING';
    case 'in_progress':
    case 'finalizing':
      return 'BATCH_STATE_RUNNING';
    case 'completed':
      return 'BATCH_STATE_SUCCEEDED';
    case 'failed':
      return 'BATCH_STATE_FAILED';
    case 'cancelling':
    case 'cancelled':
      return 'BATCH_STATE_CANCELLED';
    case 'expired':
      return 'BATCH_STATE_EXPIRED';
    default:
      return 'BATCH_STATE_UNSPECIFIED';
  }
}

function lastChangeMs(job: BatchJobRecord): number {
  return (
    job.completedAtMs ??
    job.cancelledAtMs ??
    job.expiredAtMs ??
    job.failedAtMs ??
    job.finalizingAtMs ??
    job.inProgressAtMs ??
    job.createdAtMs
  );
}

export interface ParsedGeminiBatchRequest {
  customId: string;
  body: Record<string, unknown>;
  model?: string;
}

/**
 * Reads the inlined-requests form of `:batchGenerateContent`.
 *
 * Google nests it as `batch.input_config.requests.requests`; the flatter
 * `{requests: [...]}` an SDK sometimes produces is accepted too. The
 * file-input form is not supported: this runner's inputs are request bodies,
 * not stored blobs, and pretending otherwise would mean accepting a handle it
 * would then have to reject at execution time.
 */
export function parseGeminiBatchRequests(body: unknown): ParsedGeminiBatchRequest[] {
  const entries = findInlinedRequests(body);
  if (!Array.isArray(entries) || entries.length === 0) {
    throw BatchJobError.invalid(
      'batchGenerateContent needs an inlined requests array (batch.input_config.requests.requests); the file-input form is not supported by this proxy',
      'batch.input_config.requests.requests',
    );
  }

  return entries.map((entry, index) => {
    const record = entry as Record<string, unknown> | null;
    const request = (record?.request ?? record) as Record<string, unknown> | null;
    if (typeof request !== 'object' || request === null || Array.isArray(request)) {
      throw BatchJobError.invalid(`requests[${index}].request must be an object`);
    }
    const metadata = record?.metadata as Record<string, unknown> | undefined;
    const key = metadata?.key;
    return {
      customId: typeof key === 'string' && key.trim() ? key.trim() : `request-${index}`,
      body: request,
    };
  });
}

/** Every batch line dispatches to plain `generateContent`; nothing else is servable here. */
export function buildGeminiBatchEndpoint(model: string): string {
  return `${model}:${GEMINI_SERVABLE_BATCH_ACTION}`;
}

/** The `google.rpc.Status`-shaped envelope the Gemini surface answers errors with. */
export function geminiBatchErrorResponse(error: unknown): {
  statusCode: number;
  body: { error: { code: number; message: string; status: string } };
} {
  const statusCode =
    error instanceof BatchJobError
      ? error.httpStatus
      : ((error as { httpStatus?: number })?.httpStatus ?? 500);
  const status =
    statusCode === 404 ? 'NOT_FOUND' : statusCode === 400 ? 'INVALID_ARGUMENT' : 'UNKNOWN';
  return {
    statusCode,
    body: {
      error: {
        code: statusCode,
        message: error instanceof Error ? error.message : 'Batch request failed',
        status,
      },
    },
  };
}

export function readGeminiBatchDisplayName(body: unknown): string | undefined {
  const batch = (body as Record<string, unknown> | null)?.batch as Record<string, unknown> | null;
  const displayName = batch?.displayName ?? batch?.display_name;
  return typeof displayName === 'string' && displayName.trim() ? displayName.trim() : undefined;
}

function findInlinedRequests(body: unknown): unknown[] | null {
  const root = body as Record<string, unknown> | null;
  if (!root) {
    return null;
  }
  if (Array.isArray(root.requests)) {
    return root.requests;
  }
  const batch = root.batch as Record<string, unknown> | undefined;
  const inputConfig = (batch?.inputConfig ?? batch?.input_config) as
    | Record<string, unknown>
    | undefined;
  const requests = inputConfig?.requests as Record<string, unknown> | unknown[] | undefined;
  if (Array.isArray(requests)) {
    return requests;
  }
  const nested = (requests as Record<string, unknown> | undefined)?.requests;
  return Array.isArray(nested) ? nested : null;
}
