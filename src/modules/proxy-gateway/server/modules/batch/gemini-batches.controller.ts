import { Controller, Get, Inject, Param, Query, UseGuards } from '@nestjs/common';

import { ProxyGuard } from '../../guards/proxy.guard';
import { BatchService } from './batch.service';
import { ProtocolErrors } from '../../common/protocol-errors.decorator';
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
@ProtocolErrors(geminiBatchErrorResponse)
export class GeminiBatchesController {
  constructor(@Inject(BatchService) private readonly batches: BatchService) {}

  @Get()
  list(@Query('pageSize') pageSize?: string, @Query('pageToken') pageToken?: string) {
    const page = this.batches.listGemini(pageSize, pageToken);
    return {
      batches: page.jobs.map((job) => toGeminiOperation(job)),
      ...(page.hasMore ? { nextPageToken: `${GEMINI_BATCH_PREFIX}${page.jobs.at(-1)!.id}` } : {}),
    };
  }

  @Get(':name')
  get(@Param('name') name: string) {
    return toGeminiOperation(this.batches.get('gemini', name));
  }
}
