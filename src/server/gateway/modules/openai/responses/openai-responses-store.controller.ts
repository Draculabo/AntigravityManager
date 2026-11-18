import {
  Controller,
  Delete,
  Get,
  Inject,
  NotFoundException,
  Param,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

import { ProxyGuard } from '../../../guards/proxy.guard';
import { buildResponseNotFoundError } from './openai-responses-request';
import { OpenAIResponsesSessionService } from './openai-responses-session.service';
import { getOwnedResponsesHistory, resolveResponsesHistoryOwner } from './responses-history-owner';

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
  public async getResponse(@Param('responseId') responseId: string, @Req() req: FastifyRequest) {
    const stored = this.requireStoredResponse(responseId, req);
    return this.responsesSessions.restoreResponseMedia(stored);
  }

  @Delete(':responseId')
  public async deleteResponse(@Param('responseId') responseId: string, @Req() req: FastifyRequest) {
    this.requireStoredResponse(responseId, req);
    this.responsesSessions.delete(responseId);
    return {
      id: responseId,
      object: 'response',
      deleted: true,
    };
  }

  private requireStoredResponse(responseId: string, req: FastifyRequest): Record<string, unknown> {
    const stored = getOwnedResponsesHistory(
      this.responsesSessions,
      responseId,
      resolveResponsesHistoryOwner(req.headers),
    )?.session.response;
    if (!stored) {
      throw new NotFoundException(buildResponseNotFoundError(responseId, 'id'));
    }
    return stored;
  }
}
