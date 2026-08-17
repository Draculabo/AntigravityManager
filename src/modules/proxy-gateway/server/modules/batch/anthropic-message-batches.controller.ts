import {
  Body,
  Controller,
  Delete,
  Get,
  HttpStatus,
  Inject,
  Param,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';

import { ProxyGuard } from '../../guards/proxy.guard';
import { BatchRunnerService } from './batch-runner.service';
import {
  ANTHROPIC_SERVABLE_BATCH_ENDPOINT,
  BatchJobError,
  isTerminalBatchStatus,
  parseBatchHandle,
  type BatchJobRecord,
} from './batch-job.types';
import {
  ANTHROPIC_BATCH_ID_PREFIX,
  anthropicBatchErrorResponse,
  buildAnthropicResultsJsonl,
  parseAnthropicBatchRequests,
  toAnthropicMessageBatch,
} from './anthropic-batch-resource';

/**
 * Anthropic `/v1/messages/batches`, served by the same local deferred-job
 * runner as the other two dialects.
 *
 * **Dialect selection.** `/v1/files` had to negotiate between two dialects
 * because OpenAI and Anthropic publish it at the same path; batches do not.
 * OpenAI's batch resource is `/v1/batches` and Anthropic's is
 * `/v1/messages/batches`, so the path already says which dialect is being
 * spoken and no header is consulted. `anthropic-beta` is accepted and ignored
 * rather than required: Message Batches is generally available at Anthropic,
 * so demanding a beta header would refuse requests their own current SDKs
 * send.
 *
 * Requests arrive inline in the `requests` array, unlike OpenAI's JSONL file:
 * no Files API round trip is needed on this surface.
 *
 * As with every other batch surface here, this is a local deferred-job
 * runner, not a provider batch service: no discount, no separate quota, no
 * separate rate limit.
 */
@Controller('v1/messages/batches')
@UseGuards(ProxyGuard)
export class AnthropicMessageBatchesController {
  constructor(@Inject(BatchRunnerService) private readonly runner: BatchRunnerService) {}

  @Post()
  create(@Body() body: Record<string, unknown>, @Res() res: FastifyReply): void {
    try {
      const requests = parseAnthropicBatchRequests(body);
      const job = this.runner.create({
        dialect: 'anthropic',
        endpoint: ANTHROPIC_SERVABLE_BATCH_ENDPOINT,
        requests,
      });
      res.status(HttpStatus.OK).send(toAnthropicMessageBatch(job));
    } catch (error) {
      this.sendError(res, error);
    }
  }

  /**
   * `after_id` and `before_id` are Anthropic's documented cursor pair for this
   * endpoint, and `limit` is documented as an integer from 1 to 1000
   * (default 20), same as Anthropic's other list endpoints (Models, Files).
   * Unlike OpenAI's `after`, an unresolvable cursor here answers with the
   * same 404 `not_found_error` this controller already gives `GET
   * /v1/messages/batches/{id}` for an id it never issued -- one dialect, one
   * error for "that id does not name a batch", whether it names a resource
   * or a page boundary.
   */
  @Get()
  list(
    @Res() res: FastifyReply,
    @Query('limit') limit?: string,
    @Query('after_id') afterId?: string,
    @Query('before_id') beforeId?: string,
  ) {
    try {
      if (afterId && beforeId) {
        throw BatchJobError.invalid(
          'only one of after_id or before_id may be provided',
          'after_id',
        );
      }
      const size = this.requireLimit(limit);
      const all = this.runner.list('anthropic');
      const { page, hasMore } = this.paginate(all, size, afterId, beforeId);
      const data = page.map((job) => toAnthropicMessageBatch(job));
      res.status(HttpStatus.OK).send({
        data,
        has_more: hasMore,
        first_id: data.at(0)?.id ?? null,
        last_id: data.at(-1)?.id ?? null,
      });
    } catch (error) {
      this.sendError(res, error);
    }
  }

  private requireLimit(limit?: string): number {
    if (limit === undefined || limit === '') {
      return 20;
    }
    const value = Number(limit);
    if (!Number.isInteger(value) || value < 1 || value > 1000) {
      throw BatchJobError.invalid(
        `limit must be an integer between 1 and 1000; got '${limit}'`,
        'limit',
      );
    }
    return value;
  }

  private paginate(
    all: BatchJobRecord[],
    size: number,
    afterId?: string,
    beforeId?: string,
  ): { page: BatchJobRecord[]; hasMore: boolean } {
    if (afterId) {
      const index = this.requireCursorIndex(all, afterId);
      const page = all.slice(index + 1, index + 1 + size);
      return { page, hasMore: all.length > index + 1 + page.length };
    }
    if (beforeId) {
      const index = this.requireCursorIndex(all, beforeId);
      const start = Math.max(0, index - size);
      const page = all.slice(start, index);
      return { page, hasMore: start > 0 };
    }
    const page = all.slice(0, size);
    return { page, hasMore: all.length > page.length };
  }

  /** Resolves a page-boundary cursor to its position, or 404s -- see the doc comment on `list`. */
  private requireCursorIndex(all: BatchJobRecord[], cursor: string): number {
    const startId = parseBatchHandle(cursor);
    const index = startId ? all.findIndex((job) => job.id === startId) : -1;
    if (index === -1) {
      throw BatchJobError.notFound(cursor);
    }
    return index;
  }

  @Get(':id')
  get(@Param('id') id: string, @Res() res: FastifyReply) {
    try {
      const job = this.requireJob(id);
      res.status(HttpStatus.OK).send(toAnthropicMessageBatch(job));
    } catch (error) {
      this.sendError(res, error);
    }
  }

  /**
   * Streaming JSONL results, one line per request, in submission order.
   * Available only once the batch has ended, which is what `results_url`
   * becoming non-null on the batch object announces.
   */
  @Get(':id/results')
  results(@Param('id') id: string, @Res() res: FastifyReply) {
    try {
      const job = this.requireJob(id);
      if (!isTerminalBatchStatus(job.status)) {
        throw new BatchJobError(
          'invalid_request',
          `Batch '${id}' is still ${job.status}; results are available once it has ended`,
          400,
        );
      }
      res
        .header('Content-Type', 'application/x-jsonl')
        .status(HttpStatus.OK)
        .send(buildAnthropicResultsJsonl(job));
    } catch (error) {
      this.sendError(res, error);
    }
  }

  @Post(':id/cancel')
  cancel(@Param('id') id: string, @Res() res: FastifyReply) {
    try {
      const job = this.runner.cancel(this.requireJob(id).id);
      res.status(HttpStatus.OK).send(toAnthropicMessageBatch(job));
    } catch (error) {
      this.sendError(res, error);
    }
  }

  @Delete(':id')
  remove(@Param('id') id: string, @Res() res: FastifyReply) {
    try {
      const job = this.requireJob(id);
      if (!isTerminalBatchStatus(job.status)) {
        throw new BatchJobError(
          'invalid_request',
          `Batch '${id}' is still ${job.status}; cancel it before deleting it`,
          400,
        );
      }
      this.runner.delete(job.id);
      res
        .status(HttpStatus.OK)
        .send({ id: `${ANTHROPIC_BATCH_ID_PREFIX}${job.id}`, type: 'message_batch_deleted' });
    } catch (error) {
      this.sendError(res, error);
    }
  }

  private requireJob(id: string): BatchJobRecord {
    const handle = parseBatchHandle(id);
    if (!handle) {
      throw BatchJobError.notFound(id);
    }
    const job = this.runner.require(handle);
    if (job.dialect !== 'anthropic') {
      throw BatchJobError.notFound(id);
    }
    return job;
  }

  private sendError(res: FastifyReply, error: unknown): void {
    const { statusCode, body } = anthropicBatchErrorResponse(error);
    res.status(statusCode).send(body);
  }
}
