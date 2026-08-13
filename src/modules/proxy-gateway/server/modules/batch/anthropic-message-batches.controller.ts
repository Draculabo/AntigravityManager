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

  @Get()
  list(
    @Res() res: FastifyReply,
    @Query('limit') limit?: string,
    @Query('after_id') afterId?: string,
  ) {
    try {
      const all = this.runner.list('anthropic');
      const startId = afterId ? parseBatchHandle(afterId) : null;
      const offset = startId ? all.findIndex((job) => job.id === startId) + 1 : 0;
      const size = Math.min(Math.max(Number(limit) || 20, 1), 100);
      const page = all.slice(offset, offset + size);
      const data = page.map((job) => toAnthropicMessageBatch(job));
      res.status(HttpStatus.OK).send({
        data,
        has_more: all.length > offset + page.length,
        first_id: data.at(0)?.id ?? null,
        last_id: data.at(-1)?.id ?? null,
      });
    } catch (error) {
      this.sendError(res, error);
    }
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
