import { Body, Controller, Post, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply } from 'fastify';

import { ProxyGuard } from '../../../guards/proxy.guard';
import { OpenAIOperations, type ResponsesRequestBody } from '../openai-operations.service';

@Controller('v1/responses')
@UseGuards(ProxyGuard)
export class OpenAIResponsesController {
  public constructor(private readonly operations: OpenAIOperations) {}

  @Post()
  public responses(@Body() body: ResponsesRequestBody, @Res() res: FastifyReply): Promise<void> {
    return this.operations.responses(body, res);
  }
}
