import { anthropicFileErrorResponse } from '../files/anthropic-file-resource';
import {
  BatchJobError,
  countBatchRequests,
  type BatchJobRecord,
  type BatchRequestRecord,
} from './batch-job.types';

export const ANTHROPIC_BATCH_ID_PREFIX = 'msgbatch_';

/**
 * Anthropic publishes a three-value processing status rather than OpenAI's
 * eight. The runner's internal status is mapped onto it here; nothing is
 * invented, and a batch that ended for any reason reads as `ended`.
 */
export type AnthropicProcessingStatus = 'in_progress' | 'canceling' | 'ended';

export interface AnthropicMessageBatch {
  id: string;
  type: 'message_batch';
  processing_status: AnthropicProcessingStatus;
  request_counts: {
    processing: number;
    succeeded: number;
    errored: number;
    canceled: number;
    expired: number;
  };
  ended_at: string | null;
  created_at: string;
  expires_at: string;
  archived_at: string | null;
  cancel_initiated_at: string | null;
  results_url: string | null;
}

export function toAnthropicMessageBatch(
  job: BatchJobRecord,
  resultsUrl?: string,
): AnthropicMessageBatch {
  const counts = countBatchRequests(job);
  const ended = isEnded(job);
  const id = `${ANTHROPIC_BATCH_ID_PREFIX}${job.id}`;
  return {
    id,
    type: 'message_batch',
    processing_status: toProcessingStatus(job),
    request_counts: {
      processing: counts.processing,
      succeeded: counts.succeeded,
      errored: counts.errored,
      canceled: counts.canceled,
      expired: counts.expired,
    },
    ended_at: ended ? toIso(endedAtMs(job)) : null,
    created_at: toIso(job.createdAtMs),
    expires_at: toIso(job.expiresAtMs),
    archived_at: null,
    cancel_initiated_at: job.cancellingAtMs ? toIso(job.cancellingAtMs) : null,
    results_url: ended ? (resultsUrl ?? `/v1/messages/batches/${id}/results`) : null,
  };
}

function toProcessingStatus(job: BatchJobRecord): AnthropicProcessingStatus {
  if (job.status === 'cancelling') {
    return 'canceling';
  }
  return isEnded(job) ? 'ended' : 'in_progress';
}

function isEnded(job: BatchJobRecord): boolean {
  return (
    job.status === 'completed' ||
    job.status === 'cancelled' ||
    job.status === 'expired' ||
    job.status === 'failed'
  );
}

function endedAtMs(job: BatchJobRecord): number {
  return job.completedAtMs ?? job.cancelledAtMs ?? job.expiredAtMs ?? job.failedAtMs ?? Date.now();
}

/**
 * One results line, in Anthropic's documented shape:
 * `{custom_id, result: {type: "succeeded"|"errored"|"canceled"|"expired", ...}}`.
 * A succeeded line carries `message`; an errored one carries `error`.
 */
export function toAnthropicResultLine(request: BatchRequestRecord): string {
  if (request.state === 'succeeded') {
    return JSON.stringify({
      custom_id: request.customId,
      result: { type: 'succeeded', message: request.response },
    });
  }
  if (request.state === 'errored') {
    return JSON.stringify({
      custom_id: request.customId,
      result: {
        type: 'errored',
        error: {
          type: 'error',
          error: {
            type: request.error?.code ?? 'api_error',
            message: request.error?.message ?? 'Request failed',
          },
        },
      },
    });
  }
  return JSON.stringify({
    custom_id: request.customId,
    result: { type: request.state === 'expired' ? 'expired' : 'canceled' },
  });
}

export function buildAnthropicResultsJsonl(job: BatchJobRecord): string {
  const lines = job.requests
    .filter((request) => request.state !== 'pending' && request.state !== 'running')
    .map((request) => toAnthropicResultLine(request));
  return lines.length > 0 ? `${lines.join('\n')}\n` : '';
}

export interface ParsedAnthropicBatchRequest {
  customId: string;
  body: Record<string, unknown>;
  model?: string;
}

/**
 * Reads the inline `requests` array. No file is involved on this surface, so
 * the array is the whole input; a malformed entry fails creation rather than
 * being dropped, because the client would otherwise get back fewer results
 * than it sent with no way to tell why.
 */
export function parseAnthropicBatchRequests(body: unknown): ParsedAnthropicBatchRequest[] {
  const requests = (body as Record<string, unknown> | null)?.requests;
  if (!Array.isArray(requests)) {
    throw BatchJobError.invalid('requests must be an array', 'requests');
  }
  if (requests.length === 0) {
    throw BatchJobError.invalid('requests must contain at least one entry', 'requests');
  }

  return requests.map((entry, index) => {
    const record = entry as Record<string, unknown> | null;
    const customId = record?.custom_id;
    if (typeof customId !== 'string' || !customId.trim()) {
      throw BatchJobError.invalid(
        `requests[${index}].custom_id is required`,
        `requests[${index}].custom_id`,
      );
    }
    const params = record?.params;
    if (typeof params !== 'object' || params === null || Array.isArray(params)) {
      throw BatchJobError.invalid(
        `requests[${index}].params must be a Messages request object`,
        `requests[${index}].params`,
      );
    }
    const model = (params as Record<string, unknown>).model;
    return {
      customId: customId.trim(),
      body: params as Record<string, unknown>,
      ...(typeof model === 'string' ? { model } : {}),
    };
  });
}

/**
 * The Anthropic error envelope, borrowed wholesale from the files surface --
 * the two surfaces share one dialect's error shape -- with the one status
 * batches add: an already-ended batch reports as `invalid_request_error`
 * rather than the generic `api_error` a bare 409 would otherwise map to.
 */
export function anthropicBatchErrorResponse(error: unknown) {
  const response = anthropicFileErrorResponse(error);
  if (response.statusCode === 409) {
    response.body.error.type = 'invalid_request_error';
  }
  return response;
}

function toIso(ms: number): string {
  return new Date(ms).toISOString();
}
