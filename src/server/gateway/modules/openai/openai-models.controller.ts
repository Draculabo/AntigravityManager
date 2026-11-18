import { Controller, Get, Inject, Param, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply } from 'fastify';

import { ProxyGuard } from '../../guards/proxy.guard';
import { OpenAIOperations } from './openai-operations.service';

@Controller('v1/models')
@UseGuards(ProxyGuard)
export class OpenAIModelsController {
  public constructor(@Inject(OpenAIOperations) private readonly operations: OpenAIOperations) {}

  @Get()
  public listModels(@Res() res: FastifyReply): void {
    this.operations.listModels(res);
  }

  @Get(':model')
  public retrieveModel(@Param('model') model: string, @Res() res: FastifyReply): void {
    this.operations.retrieveModel(model, res);
  }
}
