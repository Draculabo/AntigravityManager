import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';

import { ProxyGuard } from '../../guards/proxy.guard';
import { BatchService, sendBatchResponse } from './batch.service';
import {
  ANTHROPIC_SERVABLE_BATCH_ENDPOINT,
  BatchJobError,
  isTerminalBatchStatus,
} from './batch-job.types';
import {
  ANTHROPIC_BATCH_ID_PREFIX,
  anthropicBatchErrorResponse,
  buildAnthropicResultsJsonl,
  parseAnthropicBatchRequests,
  toAnthropicMessageBatch,
} from './anthropic-batch-resource';

/**
 * Anthropic `/v1/messages/batches` adapter for inline requests and streamed results.
 */
@Controller('v1/messages/batches')
@UseGuards(ProxyGuard)
export class AnthropicMessageBatchesController {
  constructor(@Inject(BatchService) private readonly batches: BatchService) {}

  @Post()
  create(@Body() body: Record<string, unknown>, @Res() res: FastifyReply): void {
    sendBatchResponse(
      res,
      () => ({
        body: toAnthropicMessageBatch(
          this.batches.create({
            dialect: 'anthropic',
            endpoint: ANTHROPIC_SERVABLE_BATCH_ENDPOINT,
            requests: parseAnthropicBatchRequests(body),
          }),
        ),
      }),
      anthropicBatchErrorResponse,
    );
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
    sendBatchResponse(
      res,
      () => {
        const page = this.batches.listAnthropic(limit, afterId, beforeId);
        const data = page.jobs.map((job) => toAnthropicMessageBatch(job));
        return {
          body: {
            data,
            has_more: page.hasMore,
            first_id: data.at(0)?.id ?? null,
            last_id: data.at(-1)?.id ?? null,
          },
        };
      },
      anthropicBatchErrorResponse,
    );
  }

  @Get(':id')
  get(@Param('id') id: string, @Res() res: FastifyReply) {
    sendBatchResponse(
      res,
      () => ({ body: toAnthropicMessageBatch(this.batches.get('anthropic', id)) }),
      anthropicBatchErrorResponse,
    );
  }

  /**
   * Streaming JSONL results, one line per request, in submission order.
   * Available only once the batch has ended, which is what `results_url`
   * becoming non-null on the batch object announces.
   */
  @Get(':id/results')
  results(@Param('id') id: string, @Res() res: FastifyReply) {
    sendBatchResponse(
      res,
      () => {
        const job = this.batches.get('anthropic', id);
        if (!isTerminalBatchStatus(job.status)) {
          throw new BatchJobError(
            'invalid_request',
            `Batch '${id}' is still ${job.status}; results are available once it has ended`,
            400,
          );
        }
        return {
          body: buildAnthropicResultsJsonl(job),
          headers: { 'Content-Type': 'application/x-jsonl' },
        };
      },
      anthropicBatchErrorResponse,
    );
  }

  @Post(':id/cancel')
  cancel(@Param('id') id: string, @Res() res: FastifyReply) {
    sendBatchResponse(
      res,
      () => ({ body: toAnthropicMessageBatch(this.batches.cancel('anthropic', id)) }),
      anthropicBatchErrorResponse,
    );
  }

  @Delete(':id')
  remove(@Param('id') id: string, @Res() res: FastifyReply) {
    sendBatchResponse(
      res,
      () => {
        const job = this.batches.get('anthropic', id);
        if (!isTerminalBatchStatus(job.status)) {
          throw new BatchJobError(
            'invalid_request',
            `Batch '${id}' is still ${job.status}; cancel it before deleting it`,
            400,
          );
        }
        this.batches.remove(job);
        return {
          body: { id: `${ANTHROPIC_BATCH_ID_PREFIX}${job.id}`, type: 'message_batch_deleted' },
        };
      },
      anthropicBatchErrorResponse,
    );
  }
}
