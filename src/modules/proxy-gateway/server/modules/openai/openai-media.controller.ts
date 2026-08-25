import { Body, Controller, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { ProxyGuard } from '../../guards/proxy.guard';
import { type ImageMonitoringRequest } from './media/image-monitoring-summary';
import { AudioRequestBody, OpenAIOperations } from './openai-operations.service';

@Controller('v1')
@UseGuards(ProxyGuard)
export class OpenAIMediaController {
  public constructor(private readonly operations: OpenAIOperations) {}

  @Post('images/generations')
  public imageGenerations(
    @Body() body: ImageMonitoringRequest,
    @Res() res: FastifyReply,
  ): Promise<void> {
    return this.operations.imageGenerations(body, res);
  }

  @Post('images/edits')
  public imageEdits(@Req() req: FastifyRequest, @Res() res: FastifyReply): Promise<void> {
    return this.operations.imageEdits(req, res);
  }

  @Post('audio/transcriptions')
  public audioTranscriptions(
    @Body() body: AudioRequestBody,
    @Req() req: FastifyRequest,
    @Res() res: FastifyReply,
  ): Promise<void> {
    return this.operations.audioTranscriptions(body, req, res);
  }

  @Post('audio/translations')
  public audioTranslations(
    @Body() body: AudioRequestBody,
    @Req() req: FastifyRequest,
    @Res() res: FastifyReply,
  ): Promise<void> {
    return this.operations.audioTranslations(body, req, res);
  }
}
