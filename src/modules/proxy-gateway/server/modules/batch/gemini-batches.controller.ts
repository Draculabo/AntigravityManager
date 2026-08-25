import { Controller, Get, Inject, Param, Query, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply } from 'fastify';

import { ProxyGuard } from '../../guards/proxy.guard';
import { BatchService, sendBatchResponse } from './batch.service';
import {
  GEMINI_BATCH_PREFIX,
  geminiBatchErrorResponse,
  toGeminiOperation,
} from './gemini-batch-resource';

/**
 * Gemini `/v1beta/batches` polling adapter for `:batchGenerateContent` jobs.
 */
@Controller('v1beta/batches')
@UseGuards(ProxyGuard)
export class GeminiBatchesController {
  constructor(@Inject(BatchService) private readonly batches: BatchService) {}

  @Get()
  list(
    @Res() res: FastifyReply,
    @Query('pageSize') pageSize?: string,
    @Query('pageToken') pageToken?: string,
  ) {
    sendBatchResponse(
      res,
      () => {
        const page = this.batches.listGemini(pageSize, pageToken);
        return {
          body: {
            batches: page.jobs.map((job) => toGeminiOperation(job)),
            ...(page.hasMore
              ? { nextPageToken: `${GEMINI_BATCH_PREFIX}${page.jobs.at(-1)!.id}` }
              : {}),
          },
        };
      },
      geminiBatchErrorResponse,
    );
  }

  @Get(':name')
  get(@Param('name') name: string, @Res() res: FastifyReply) {
    sendBatchResponse(
      res,
      () => ({ body: toGeminiOperation(this.batches.get('gemini', name)) }),
      geminiBatchErrorResponse,
    );
  }
}
