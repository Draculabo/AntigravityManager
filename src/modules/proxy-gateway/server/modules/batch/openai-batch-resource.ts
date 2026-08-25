import {
  BatchJobError,
  OPENAI_SERVABLE_BATCH_ENDPOINT,
  countBatchRequests,
  type BatchJobRecord,
  type BatchRequestRecord,
} from './batch-job.types';

export const OPENAI_BATCH_ID_PREFIX = 'batch_';
/** OpenAI documents exactly one window, so anything else is a client mistake. */
export const OPENAI_COMPLETION_WINDOW = '24h';

export interface OpenAIBatchObject {
  id: string;
  object: 'batch';
  endpoint: string;
  errors: { object: 'list'; data: Array<{ code: string; message: string; line?: number }> } | null;
  input_file_id: string | null;
  completion_window: string;
  status: string;
  output_file_id: string | null;
  error_file_id: string | null;
  created_at: number;
  in_progress_at: number | null;
  expires_at: number;
  finalizing_at: number | null;
  completed_at: number | null;
  failed_at: number | null;
  expired_at: number | null;
  cancelling_at: number | null;
  cancelled_at: number | null;
  request_counts: { total: number; completed: number; failed: number };
  metadata: Record<string, string> | null;
}

export function toOpenAIBatchObject(job: BatchJobRecord): OpenAIBatchObject {
  const counts = countBatchRequests(job);
  return {
    id: `${OPENAI_BATCH_ID_PREFIX}${job.id}`,
    object: 'batch',
    endpoint: job.endpoint,
    errors: job.error
      ? { object: 'list', data: [{ code: job.error.code, message: job.error.message }] }
      : null,
    input_file_id: job.inputFileId ?? null,
    completion_window: job.completionWindow ?? OPENAI_COMPLETION_WINDOW,
    status: job.status,
    output_file_id: job.outputFileId ?? null,
    error_file_id: job.errorFileId ?? null,
    created_at: toSeconds(job.createdAtMs),
    in_progress_at: toOptionalSeconds(job.inProgressAtMs),
    expires_at: toSeconds(job.expiresAtMs),
    finalizing_at: toOptionalSeconds(job.finalizingAtMs),
    completed_at: toOptionalSeconds(job.completedAtMs),
    failed_at: toOptionalSeconds(job.failedAtMs),
    expired_at: toOptionalSeconds(job.expiredAtMs),
    cancelling_at: toOptionalSeconds(job.cancellingAtMs),
    cancelled_at: toOptionalSeconds(job.cancelledAtMs),
    // Reported from the live request records, so it is never ahead of reality.
    request_counts: {
      total: counts.total,
      completed: counts.succeeded,
      failed: counts.errored + counts.expired + counts.canceled,
    },
    metadata: job.metadata ?? null,
  };
}

/**
 * Validates the `endpoint` a batch was created for.
 *
 * Only `/v1/chat/completions` is servable on this surface today; see the
 * comment on {@link OPENAI_SERVABLE_BATCH_ENDPOINT}'s source for why
 * `/v1/responses` is not offered yet, and why `/v1/embeddings` is called out
 * by name below rather than folded into a generic message: there is no
 * embedding RPC on this transport at all, established from the vendor's
 * protobuf descriptors and corroborated by `gemini-cli` implementing
 * `embedContent()` as a `throw`. It cannot be served in a batch because it
 * cannot be served at all.
 */
export function requireServableEndpoint(endpoint: unknown): string {
  if (typeof endpoint !== 'string' || !endpoint.trim()) {
    throw BatchJobError.invalid('endpoint is required', 'endpoint');
  }
  const normalized = endpoint.trim();
  if (normalized !== OPENAI_SERVABLE_BATCH_ENDPOINT) {
    throw BatchJobError.unservableEndpoint(normalized, [OPENAI_SERVABLE_BATCH_ENDPOINT]);
  }
  return normalized;
}

export function requireCompletionWindow(value: unknown): string {
  const window = typeof value === 'string' ? value.trim() : '';
  if (!window) {
    throw BatchJobError.invalid('completion_window is required', 'completion_window');
  }
  if (window !== OPENAI_COMPLETION_WINDOW) {
    throw BatchJobError.invalid(
      `completion_window '${window}' is not supported; the only supported window is ${OPENAI_COMPLETION_WINDOW}`,
      'completion_window',
    );
  }
  return window;
}

export function normalizeBatchMetadata(value: unknown): Record<string, string> | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw BatchJobError.invalid('metadata must be an object of string values', 'metadata');
  }
  const metadata: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry !== 'string') {
      throw BatchJobError.invalid(`metadata.${key} must be a string`, 'metadata');
    }
    metadata[key] = entry;
  }
  return metadata;
}

export interface ParsedBatchInputLine {
  customId: string;
  body: unknown;
  model?: string;
}

/**
 * Parses the uploaded JSONL. Every line must name a `custom_id`, the `url` it
 * declares must match the batch's endpoint, and a malformed line fails the
 * whole creation rather than being silently skipped -- the client would
 * otherwise get back fewer results than it sent with no way to tell why.
 */
export function parseBatchInputJsonl(content: string, endpoint: string): ParsedBatchInputLine[] {
  const lines = content.split(/\r?\n/u);
  const parsed: ParsedBatchInputLine[] = [];
  for (const [index, raw] of lines.entries()) {
    const line = raw.trim();
    if (!line) {
      continue;
    }
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(line) as Record<string, unknown>;
    } catch {
      throw BatchJobError.invalid(`Line ${index + 1} of the input file is not valid JSON`);
    }
    const customId = record.custom_id;
    if (typeof customId !== 'string' || !customId.trim()) {
      throw BatchJobError.invalid(`Line ${index + 1} of the input file has no custom_id`);
    }
    if (typeof record.url === 'string' && record.url.trim() !== endpoint) {
      throw BatchJobError.invalid(
        `Line ${index + 1} targets '${String(record.url)}' but the batch endpoint is '${endpoint}'`,
      );
    }
    const body = record.body;
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      throw BatchJobError.invalid(`Line ${index + 1} of the input file has no body object`);
    }
    const model = (body as Record<string, unknown>).model;
    parsed.push({
      customId: customId.trim(),
      body,
      ...(typeof model === 'string' ? { model } : {}),
    });
  }
  if (parsed.length === 0) {
    throw BatchJobError.invalid('The input file contains no requests');
  }
  return parsed;
}

/** One output line, in the documented `{id, custom_id, response, error}` shape. */
export function toOpenAIOutputLine(job: BatchJobRecord, request: BatchRequestRecord): string {
  const id = `${OPENAI_BATCH_ID_PREFIX}req_${job.id}_${request.customId}`;
  if (request.state === 'succeeded') {
    return JSON.stringify({
      id,
      custom_id: request.customId,
      response: { status_code: 200, request_id: id, body: request.response },
      error: null,
    });
  }
  return JSON.stringify({
    id,
    custom_id: request.customId,
    response: null,
    error: {
      code: request.error?.code ?? request.state,
      message: request.error?.message ?? `Request ${request.state}`,
    },
  });
}

export function buildOpenAIOutputFiles(job: BatchJobRecord): {
  output: string;
  errors: string;
} {
  const succeeded: string[] = [];
  const failed: string[] = [];
  for (const request of job.requests) {
    const line = toOpenAIOutputLine(job, request);
    (request.state === 'succeeded' ? succeeded : failed).push(line);
  }
  return {
    output: succeeded.length > 0 ? `${succeeded.join('\n')}\n` : '',
    errors: failed.length > 0 ? `${failed.join('\n')}\n` : '',
  };
}

/** The OpenAI error envelope, with the runner's own code rather than a file code. */
export function openAIBatchErrorResponse(error: unknown): {
  statusCode: number;
  body: { error: { code: string | null; message: string; param: string | null; type: string } };
} {
  const statusCode =
    error instanceof BatchJobError
      ? error.httpStatus
      : ((error as { httpStatus?: number })?.httpStatus ?? 500);
  return {
    statusCode,
    body: {
      error: {
        code: error instanceof BatchJobError ? error.code : null,
        message: error instanceof Error ? error.message : 'Batch request failed',
        param: error instanceof BatchJobError ? (error.param ?? null) : null,
        type: statusCode >= 500 ? 'server_error' : 'invalid_request_error',
      },
    },
  };
}

function toSeconds(ms: number): number {
  return Math.floor(ms / 1000);
}

function toOptionalSeconds(ms: number | undefined): number | null {
  return typeof ms === 'number' ? toSeconds(ms) : null;
}
