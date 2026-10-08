import {
  Controller,
  Delete,
  Get,
  Inject,
  NotFoundException,
  Param,
  UseGuards,
} from '@nestjs/common';

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
  public getResponse(@Param('responseId') responseId: string) {
    return this.requireStoredResponse(responseId);
  }

  @Delete(':responseId')
  public deleteResponse(@Param('responseId') responseId: string) {
    this.requireStoredResponse(responseId);
    this.responsesSessions.delete(responseId);
    return {
      id: responseId,
      object: 'response',
      deleted: true,
    };
  }

  private requireStoredResponse(responseId: string) {
    const stored = this.responsesSessions.get(responseId)?.response;
    if (!stored) {
      throw new NotFoundException(buildResponseNotFoundError(responseId, 'id'));
    }
    return stored;
  }
}
