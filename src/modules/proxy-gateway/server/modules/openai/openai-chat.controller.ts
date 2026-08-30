import { Body, Controller, Get, Inject, Param, Post, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply } from 'fastify';

import { ProxyGuard } from '../../guards/proxy.guard';
import { OpenAIOperations, type OpenAITextCompletionRequest } from './openai-operations.service';
import type { OpenAIChatRequest } from '../../common/interfaces/request-interfaces';

@Controller('v1')
@UseGuards(ProxyGuard)
export class OpenAIChatController {
  public constructor(@Inject(OpenAIOperations) private readonly operations: OpenAIOperations) {}

  @Post('chat/completions')
  public chatCompletions(@Body() body: OpenAIChatRequest, @Res() res: FastifyReply): Promise<void> {
    return this.operations.chatCompletions(body, res);
  }

  @Get('chat/completions/:completionId')
  public getStoredChatCompletion(
    @Param('completionId') completionId: string,
    @Res() res: FastifyReply,
  ): void {
    this.operations.getStoredChatCompletion(completionId, res);
  }

  @Post('completions')
  public completions(
    @Body() body: OpenAITextCompletionRequest,
    @Res() res: FastifyReply,
  ): Promise<void> {
    return this.operations.completions(body, res);
  }
}
