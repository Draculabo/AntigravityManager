/**
 * Shared vocabulary for the local batch runner.
 *
 * The provider surface this proxy speaks to (`v1internal` on `cloudcode-pa`) has
 * **no batch plane**: there is no batch resource, no deferred submission, no
 * server-side job. This is a **local deferred-job runner** over the same
 * `generateContent`-family calls the proxy already makes for interactive
 * traffic. It is a real implementation of the client-facing contract -- submit
 * a set of requests, poll, collect results line by line, survive a dropped
 * connection and an app restart -- and it is worth having for clients that only
 * speak batch.
 *
 * It is **not** the economics of a real batch API: there is no 50% discount, no
 * separate quota pool, and no separate rate limit. Every request costs exactly
 * what it would cost sent normally, right now, against the same account leases
 * and the same rate-limit tracking interactive traffic uses.
 *
 * This file owns the runner's vocabulary -- job/request shape, state values,
 * error codes, id parsing. The client-facing protocol surfaces
 * (`/v1/batches`, `/v1/messages/batches`, `:batchGenerateContent`,
 * `/v1beta/operations`) each live in their own controller and resource module
 * beside `batch-runner.service.ts`, one per dialect, wired up in
 * `batch.module.ts`.
 */

/** Which client dialect created the batch. Fixed at creation, never inferred later. */
export type BatchDialect = 'openai' | 'anthropic' | 'gemini';

/**
 * The batch lifecycle, using OpenAI's documented vocabulary verbatim because it
 * is the most granular of the three. Future Anthropic and Gemini adapters map
 * this onto their own smaller vocabularies; no status is invented here.
 */
export type BatchStatus =
  | 'validating'
  | 'in_progress'
  | 'finalizing'
  | 'completed'
  | 'failed'
  | 'cancelling'
  | 'cancelled'
  | 'expired';

/** Terminal outcome of one request inside a batch, Anthropic's `result.type` set. */
export type BatchRequestOutcome = 'succeeded' | 'errored' | 'canceled' | 'expired';

export type BatchRequestState = 'pending' | 'running' | BatchRequestOutcome;

/**
 * Every endpoint this proxy's batch runner can genuinely execute, one per
 * dialect, now that the local Files API exists to carry OpenAI's JSONL input
 * and output.
 *
 * `/v1/responses` is still deliberately absent from the OpenAI slot: it needs
 * the Responses request/response conversion that lives behind a controller,
 * and claiming it works before that conversion is wired would be exactly the
 * kind of promise this port refuses to make. Anthropic and Gemini are not
 * endpoint-scoped the way OpenAI is -- {@link BatchDialect} alone routes a job
 * to the right handler -- so their entries here document, and their
 * surface-level tests prove, the one execution path each dialect's protocol
 * surface actually wires up rather than gating dispatch a second time.
 */
export const SERVABLE_BATCH_ENDPOINTS = [
  '/v1/chat/completions',
  '/v1/messages',
  'generateContent',
] as const;

/** The one OpenAI batch endpoint this proxy serves. */
export const OPENAI_SERVABLE_BATCH_ENDPOINT = SERVABLE_BATCH_ENDPOINTS[0];
/** The one Anthropic batch endpoint this proxy serves. */
export const ANTHROPIC_SERVABLE_BATCH_ENDPOINT = SERVABLE_BATCH_ENDPOINTS[1];
/** The Gemini action a batch request line is ultimately dispatched to. */
export const GEMINI_SERVABLE_BATCH_ACTION = SERVABLE_BATCH_ENDPOINTS[2];

export interface BatchRequestError {
  message: string;
  /** Dialect-neutral code; a future adapter translates it into its own envelope. */
  code: string;
  httpStatus: number;
}

/** One request line, plus wherever it got to. */
export interface BatchRequestRecord {
  customId: string;
  state: BatchRequestState;
  /** The client's body, exactly as submitted, minus transport-only fields. */
  body: unknown;
  /** Model named by the body, retained so a listing can be read without parsing. */
  model?: string;
  /** For Gemini, the `models/x` the action was addressed to. */
  target?: string;
  response?: unknown;
  error?: BatchRequestError;
  startedAtMs?: number;
  finishedAtMs?: number;
}

export interface BatchJobRecord {
  id: string;
  dialect: BatchDialect;
  /** OpenAI/Anthropic endpoint path, or `models/x:generateContent` for Gemini. */
  endpoint: string;
  status: BatchStatus;
  requests: BatchRequestRecord[];
  createdAtMs: number;
  /** When processing must stop. Derived from `completion_window`. */
  expiresAtMs: number;
  inProgressAtMs?: number;
  finalizingAtMs?: number;
  completedAtMs?: number;
  failedAtMs?: number;
  cancellingAtMs?: number;
  cancelledAtMs?: number;
  expiredAtMs?: number;
  completionWindow?: string;
  displayName?: string;
  metadata?: Record<string, string>;
  /** Set when the whole batch failed before any request ran. */
  error?: BatchRequestError;
  /** OpenAI only: the `FileContentStore` handle the input JSONL was read from. */
  inputFileId?: string;
  /** OpenAI only: the `FileContentStore` handle the succeeded-line JSONL was written to. */
  outputFileId?: string;
  /** OpenAI only: the `FileContentStore` handle the failed-line JSONL was written to. */
  errorFileId?: string;
}

export type BatchErrorCode =
  | 'invalid_request'
  | 'unservable_endpoint'
  | 'not_found'
  | 'already_ended'
  | 'store_unavailable';

/** Every failure the runner raises, carrying the HTTP status a future adapter reuses. */
export class BatchJobError extends Error {
  public readonly code: BatchErrorCode;
  public readonly httpStatus: number;
  public readonly param?: string;

  constructor(code: BatchErrorCode, message: string, httpStatus: number, param?: string) {
    super(message);
    this.name = 'BatchJobError';
    this.code = code;
    this.httpStatus = httpStatus;
    this.param = param;
  }

  public static invalid(message: string, param?: string): BatchJobError {
    return new BatchJobError('invalid_request', message, 400, param);
  }

  public static notFound(id: string): BatchJobError {
    return new BatchJobError('not_found', `Batch '${id}' was never created by this proxy`, 404);
  }

  public static unservableEndpoint(endpoint: string, servable: readonly string[]): BatchJobError {
    return new BatchJobError(
      'unservable_endpoint',
      `endpoint '${endpoint}' cannot be served by this proxy's batch runner; supported endpoints are ${servable.join(
        ', ',
      )}.`,
      400,
      'endpoint',
    );
  }

  public static alreadyEnded(id: string, status: BatchStatus): BatchJobError {
    return new BatchJobError('already_ended', `Batch '${id}' has already ${status}`, 409);
  }
}

/**
 * Defaults sized for an Electron app running alongside interactive traffic.
 *
 * `DEFAULT_BATCH_CONCURRENCY` is deliberately tiny. The proxy has no global
 * concurrency limiter: account leasing hands out an account per request and
 * rate-limit tracking only reacts to upstream 429s by locking that account out
 * -- a lockout the interactive path then shares. A batch is by definition not
 * urgent, so it runs two requests at a time and leaves the rest of the
 * account's headroom to whoever is waiting on a response. Raise it with
 * `AGM_BATCH_MAX_CONCURRENCY` if that trade is wrong for a given install.
 */
export const DEFAULT_BATCH_CONCURRENCY = 2;
/** 48 hours, a generous but bounded retention for a batch nobody collected. */
export const DEFAULT_BATCH_TTL_MS = 48 * 60 * 60 * 1000;
/** OpenAI's only documented completion window, and the processing deadline honoured here. */
export const DEFAULT_COMPLETION_WINDOW_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_MAX_BATCHES = 200;
export const DEFAULT_MAX_REQUESTS_PER_BATCH = 10_000;

export interface BatchRunnerOptions {
  /** Absolute path of the backing JSON file. Omit for an in-memory runner. */
  filePath?: string;
  maxConcurrency?: number;
  ttlMs?: number;
  maxBatches?: number;
  maxRequestsPerBatch?: number;
}

const BATCH_ID_PATTERN = /^[0-9a-f]{24}$/u;

/** Accepts the id spellings a future surface hands back and returns the bare id. */
export function parseBatchHandle(handle: string): string | null {
  const trimmed = (handle ?? '').trim();
  if (!trimmed) {
    return null;
  }
  const candidate = trimmed
    .replace(/^\/?(?:v1beta\/)?(?:operations|batches)\//iu, '')
    .replace(/^(?:batch_|batch-|msgbatch_|operations\/)/iu, '')
    .toLowerCase();
  return BATCH_ID_PATTERN.test(candidate) ? candidate : null;
}

export function isBatchId(value: string): boolean {
  return BATCH_ID_PATTERN.test(value);
}

/** Live counts, recomputed from the request records rather than cached. */
export interface BatchRequestCounts {
  total: number;
  processing: number;
  succeeded: number;
  errored: number;
  canceled: number;
  expired: number;
}

export function countBatchRequests(job: BatchJobRecord): BatchRequestCounts {
  const counts: BatchRequestCounts = {
    total: job.requests.length,
    processing: 0,
    succeeded: 0,
    errored: 0,
    canceled: 0,
    expired: 0,
  };
  for (const request of job.requests) {
    if (request.state === 'pending' || request.state === 'running') {
      counts.processing += 1;
      continue;
    }
    counts[request.state] += 1;
  }
  return counts;
}

export function isTerminalBatchStatus(status: BatchStatus): boolean {
  return (
    status === 'completed' || status === 'failed' || status === 'cancelled' || status === 'expired'
  );
}

/**
 * Validates one record read back from disk. Anything that does not describe a
 * batch is dropped rather than repaired, which is how a hand-edited or
 * partially understood state file is survived.
 */
export function reviveBatchJob(value: unknown): BatchJobRecord | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Partial<BatchJobRecord>;
  if (!record.id || !isBatchId(record.id) || !record.dialect || !record.status) {
    return null;
  }
  if (!Array.isArray(record.requests) || typeof record.createdAtMs !== 'number') {
    return null;
  }
  for (const request of record.requests) {
    if (!request || typeof request.customId !== 'string' || typeof request.state !== 'string') {
      return null;
    }
  }
  return record as BatchJobRecord;
}
