import {
  Body,
  Controller,
  HttpStatus,
  Inject,
  Param,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { ProxyGuard } from '../../guards/proxy.guard';
import { normalizeUploadError, parseFileUploadRequest } from '../files/file-upload-request';
import { toOpenAIFileObject } from '../files/openai-file-resource';
import {
  openAIUploadErrorResponse,
  toOpenAIUploadObject,
  toOpenAIUploadPartObject,
} from './openai-upload-resource';
import { OpenAIUploadsService } from './openai-uploads.service';

/** The OpenAI Uploads protocol commits completed parts into the local Files plane. */
@Controller('v1/uploads')
@UseGuards(ProxyGuard)
export class OpenAIUploadsController {
  public constructor(
    @Inject(OpenAIUploadsService) private readonly uploads: OpenAIUploadsService,
  ) {}

  @Post()
  public create(@Body() body: unknown, @Res() res: FastifyReply): void {
    try {
      const upload = this.uploads.create(body);
      res.status(HttpStatus.OK).send(toOpenAIUploadObject(upload));
    } catch (error) {
      this.sendError(res, error);
    }
  }

  @Post(':id/parts')
  public async addPart(
    @Param('id') id: string,
    @Req() request: FastifyRequest,
    @Res() res: FastifyReply,
  ): Promise<void> {
    try {
      const upload = await parseFileUploadRequest(request, { allowRawBody: false });
      const part = this.uploads.addPart(id, upload.bytes);
      res.status(HttpStatus.OK).send(toOpenAIUploadPartObject(id, part));
    } catch (error) {
      this.sendError(res, normalizeUploadError(error));
    }
  }

  @Post(':id/complete')
  public async complete(
    @Param('id') id: string,
    @Body() body: unknown,
    @Res() res: FastifyReply,
  ): Promise<void> {
    try {
      const file = await this.uploads.complete(id, body);
      res.status(HttpStatus.OK).send(toOpenAIFileObject(file));
    } catch (error) {
      this.sendError(res, error);
    }
  }

  @Post(':id/cancel')
  public cancel(@Param('id') id: string, @Res() res: FastifyReply): void {
    try {
      const upload = this.uploads.cancel(id);
      res.status(HttpStatus.OK).send(toOpenAIUploadObject(upload, 'cancelled'));
    } catch (error) {
      this.sendError(res, error);
    }
  }

  private sendError(res: FastifyReply, error: unknown): void {
    const { statusCode, body } = openAIUploadErrorResponse(error);
    res.status(statusCode).send(body);
  }
}
