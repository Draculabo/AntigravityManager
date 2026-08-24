import { Body, Controller, Get, Inject, Param, Post, Query, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply } from 'fastify';

import { ProxyGuard } from '../../guards/proxy.guard';
import { BatchJobError } from './batch-job.types';
import { BatchService, sendAsyncBatchResponse, sendBatchResponse } from './batch.service';
import {
  normalizeBatchMetadata,
  openAIBatchErrorResponse,
  parseBatchInputJsonl,
  requireCompletionWindow,
  requireServableEndpoint,
  toOpenAIBatchObject,
} from './openai-batch-resource';

/**
 * OpenAI `/v1/batches` adapter. BatchService owns jobs, pagination, and Files operations.
 */
@Controller('v1/batches')
@UseGuards(ProxyGuard)
export class OpenAIBatchesController {
  constructor(@Inject(BatchService) private readonly batches: BatchService) {}

  @Post()
  async create(@Body() body: Record<string, unknown>, @Res() res: FastifyReply): Promise<void> {
    await sendAsyncBatchResponse(
      res,
      async () => {
        const endpoint = requireServableEndpoint(body?.endpoint);
        const completionWindow = requireCompletionWindow(body?.completion_window);
        const metadata = normalizeBatchMetadata(body?.metadata);
        const inputFileId = requireString(body?.input_file_id, 'input_file_id');
        const content = await this.batches.readOpenAIInput(inputFileId);
        const lines = parseBatchInputJsonl(content, endpoint);

        const job = this.batches.create({
          dialect: 'openai',
          endpoint,
          completionWindow,
          inputFileId,
          requests: lines,
          ...(metadata ? { metadata } : {}),
        });
        return { body: toOpenAIBatchObject(job) };
      },
      openAIBatchErrorResponse,
    );
  }

  /**
   * `after` is Stripe-style opaque cursor pagination: a page boundary, not a
   * resource lookup. When `after` names an id this runner never issued, or
   * one that has since aged out of {@link DEFAULT_MAX_BATCHES} retention,
   * OpenAI's own list endpoints answer with an empty, terminal page rather
   * than an error -- so a client that kept the id from an earlier page and
   * paged past everything this proxy still remembers stops cleanly instead
   * of silently looping back to page one.
   */
  @Get()
  list(@Res() res: FastifyReply, @Query('limit') limit?: string, @Query('after') after?: string) {
    sendBatchResponse(
      res,
      () => {
        const page = this.batches.listOpenAI(limit, after);
        const data = page.jobs.map((job) => toOpenAIBatchObject(job));
        return {
          body: {
            object: 'list',
            data,
            first_id: data.at(0)?.id ?? null,
            last_id: data.at(-1)?.id ?? null,
            has_more: page.hasMore,
          },
        };
      },
      openAIBatchErrorResponse,
    );
  }

  @Get(':id')
  get(@Param('id') id: string, @Res() res: FastifyReply) {
    sendBatchResponse(
      res,
      () => ({ body: toOpenAIBatchObject(this.batches.get('openai', id)) }),
      openAIBatchErrorResponse,
    );
  }

  @Post(':id/cancel')
  cancel(@Param('id') id: string, @Res() res: FastifyReply) {
    sendBatchResponse(
      res,
      () => ({ body: toOpenAIBatchObject(this.batches.cancel('openai', id)) }),
      openAIBatchErrorResponse,
    );
  }
}

function requireString(value: unknown, param: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw BatchJobError.invalid(`${param} is required`, param);
  }
  return value.trim();
}
