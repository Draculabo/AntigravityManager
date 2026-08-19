import { Controller, Get, HttpStatus, Inject, Param, Query, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply } from 'fastify';

import { ProxyGuard } from '../../guards/proxy.guard';
import { BatchRunnerService } from './batch-runner.service';
import { BatchJobError, parseBatchHandle } from './batch-job.types';
import {
  GEMINI_BATCH_PREFIX,
  geminiBatchErrorResponse,
  toGeminiOperation,
} from './gemini-batch-resource';

/**
 * The polling half of Gemini's `:batchGenerateContent`.
 *
 * `:batchGenerateContent` answers with a long-running-operation-shaped
 * resource, so a client needs somewhere to poll it. This is served on
 * `/v1beta/batches`, the path and `batches/{id}` naming the current Gemini
 * Batch API actually uses -- not `/v1beta/operations`, which this proxy
 * exposed in an earlier revision of this port but which no real Gemini batch
 * client polls. That alias has been removed rather than carried forward: no
 * client of this proxy is known to depend on it, and keeping a second name
 * for the same resource only so it exists would mean maintaining two
 * contracts for one feature. `parseBatchHandle` still accepts an
 * `operations/` prefix on top of `batches/`, so nothing about handle parsing
 * needed to change.
 *
 * Only the two methods that serves are implemented: list and get.
 * `batches.cancel` (and `operations.cancel`/`operations.delete`) are
 * deliberately absent: this dialect has no batch-cancel route of its own
 * either, and this proxy will not publish a control plane it does not have.
 */
@Controller('v1beta/batches')
@UseGuards(ProxyGuard)
export class GeminiBatchesController {
  constructor(@Inject(BatchRunnerService) private readonly runner: BatchRunnerService) {}

  @Get()
  list(
    @Res() res: FastifyReply,
    @Query('pageSize') pageSize?: string,
    @Query('pageToken') pageToken?: string,
  ) {
    try {
      const all = this.runner.list('gemini');
      const startId = pageToken ? parseBatchHandle(pageToken) : null;
      if (pageToken && !startId) {
        throw BatchJobError.invalid(`pageToken '${pageToken}' is not a batch this proxy issued`);
      }
      const offset = startId ? all.findIndex((job) => job.id === startId) + 1 : 0;
      const size = Math.min(Math.max(Number(pageSize) || 50, 1), 100);
      const page = all.slice(offset, offset + size);
      const batches = page.map((job) => toGeminiOperation(job));
      const hasMore = all.length > offset + page.length;
      res.status(HttpStatus.OK).send({
        batches,
        ...(hasMore ? { nextPageToken: `${GEMINI_BATCH_PREFIX}${page.at(-1)!.id}` } : {}),
      });
    } catch (error) {
      this.sendError(res, error);
    }
  }

  @Get(':name')
  get(@Param('name') name: string, @Res() res: FastifyReply) {
    try {
      const handle = parseBatchHandle(name);
      if (!handle) {
        throw BatchJobError.notFound(name);
      }
      const job = this.runner.require(handle);
      if (job.dialect !== 'gemini') {
        throw BatchJobError.notFound(name);
      }
      res.status(HttpStatus.OK).send(toGeminiOperation(job));
    } catch (error) {
      this.sendError(res, error);
    }
  }

  private sendError(res: FastifyReply, error: unknown): void {
    const { statusCode, body } = geminiBatchErrorResponse(error);
    res.status(statusCode).send(body);
  }
}
