import { Controller, Get, HttpStatus, Inject, Param, Query, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply } from 'fastify';

import { ProxyGuard } from '../../guards/proxy.guard';
import { BatchRunnerService } from './batch-runner.service';
import { BatchJobError, parseBatchHandle } from './batch-job.types';
import { geminiBatchErrorResponse, toGeminiOperation } from './gemini-batch-resource';

/**
 * The polling half of Gemini's `:batchGenerateContent`.
 *
 * `:batchGenerateContent` answers with a long-running operation, so a client
 * needs somewhere to poll it. Only the two methods that serves are
 * implemented: list and get. `operations.cancel` and `operations.delete` are
 * deliberately absent: this dialect has no batch-cancel route of its own
 * either, and this proxy will not publish an operations control plane it does
 * not have.
 */
@Controller('v1beta/operations')
@UseGuards(ProxyGuard)
export class GeminiOperationsController {
  constructor(@Inject(BatchRunnerService) private readonly runner: BatchRunnerService) {}

  @Get()
  list(@Res() res: FastifyReply, @Query('pageSize') pageSize?: string) {
    try {
      const size = Math.min(Math.max(Number(pageSize) || 50, 1), 100);
      const operations = this.runner
        .list('gemini')
        .slice(0, size)
        .map((job) => toGeminiOperation(job));
      res.status(HttpStatus.OK).send({ operations });
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
