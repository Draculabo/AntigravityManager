import { Controller, Delete, Get, HttpStatus, Inject, Param, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply } from 'fastify';

import { ProxyGuard } from '../../../guards/proxy.guard';
import { buildResponseNotFoundError } from './openai-responses-request';
import { OpenAIResponsesSessionService } from './openai-responses-session.service';

/**
 * Read and delete access to stored Responses, over the same durable store the
 * `previous_response_id` chain resolves against.
 *
 * A response created with `store: false` was never written, so it is reported as
 * not found here rather than as an empty success, and delete answers for exactly
 * what get would have returned.
 */
@Controller('v1/responses')
@UseGuards(ProxyGuard)
export class OpenAIResponsesStoreController {
  public constructor(
    @Inject(OpenAIResponsesSessionService)
    private readonly responsesSessions: OpenAIResponsesSessionService,
  ) {}

  @Get(':responseId')
  public getResponse(@Param('responseId') responseId: string, @Res() res: FastifyReply): void {
    const stored = this.responsesSessions.get(responseId)?.response;
    if (!stored) {
      res.status(HttpStatus.NOT_FOUND).send(buildResponseNotFoundError(responseId, 'id'));
      return;
    }

    res.status(HttpStatus.OK).send(stored);
  }

  @Delete(':responseId')
  public deleteResponse(@Param('responseId') responseId: string, @Res() res: FastifyReply): void {
    if (!this.responsesSessions.get(responseId)?.response) {
      res.status(HttpStatus.NOT_FOUND).send(buildResponseNotFoundError(responseId, 'id'));
      return;
    }

    this.responsesSessions.delete(responseId);
    res.status(HttpStatus.OK).send({
      id: responseId,
      object: 'response',
      deleted: true,
    });
  }
}
