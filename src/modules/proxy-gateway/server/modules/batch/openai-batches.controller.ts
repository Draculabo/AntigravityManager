import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';

import { ProxyGuard } from '../../guards/proxy.guard';
import { BatchJobError } from './batch-job.types';
import { BatchService } from './batch.service';
import { ProtocolErrors } from '../../common/protocol-errors.decorator';
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
@ProtocolErrors(openAIBatchErrorResponse)
export class OpenAIBatchesController {
  constructor(@Inject(BatchService) private readonly batches: BatchService) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  async create(@Body() body: Record<string, unknown>) {
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
    return toOpenAIBatchObject(job);
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
  list(@Query('limit') limit?: string, @Query('after') after?: string) {
    const page = this.batches.listOpenAI(limit, after);
    const data = page.jobs.map((job) => toOpenAIBatchObject(job));
    return {
      object: 'list',
      data,
      first_id: data.at(0)?.id ?? null,
      last_id: data.at(-1)?.id ?? null,
      has_more: page.hasMore,
    };
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return toOpenAIBatchObject(this.batches.get('openai', id));
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  cancel(@Param('id') id: string) {
    return toOpenAIBatchObject(this.batches.cancel('openai', id));
  }
}

function requireString(value: unknown, param: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw BatchJobError.invalid(`${param} is required`, param);
  }
  return value.trim();
}
