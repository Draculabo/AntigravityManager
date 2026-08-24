import { Body, Controller, Inject, Param, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { ProxyGuard } from '../../guards/proxy.guard';
import { normalizeUploadError, parseFileUploadRequest } from '../files/file-upload-request';
import { sendFilesResponse } from '../files/files.service';
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
  public async create(@Body() body: unknown, @Res() res: FastifyReply): Promise<void> {
    await sendFilesResponse(
      res,
      async () => ({
        body: toOpenAIUploadObject(this.uploads.create(body)),
      }),
      openAIUploadErrorResponse,
    );
  }

  @Post(':id/parts')
  public async addPart(
    @Param('id') id: string,
    @Req() request: FastifyRequest,
    @Res() res: FastifyReply,
  ): Promise<void> {
    await sendFilesResponse(
      res,
      async () => {
        const upload = await parseFileUploadRequest(request, { allowRawBody: false });
        const part = this.uploads.addPart(id, upload.bytes);
        return {
          body: toOpenAIUploadPartObject(id, part),
        };
      },
      openAIUploadErrorResponse,
      normalizeUploadError,
    );
  }

  @Post(':id/complete')
  public async complete(
    @Param('id') id: string,
    @Body() body: unknown,
    @Res() res: FastifyReply,
  ): Promise<void> {
    await sendFilesResponse(
      res,
      async () => {
        const file = await this.uploads.complete(id, body);
        return {
          body: toOpenAIFileObject(file),
        };
      },
      openAIUploadErrorResponse,
    );
  }

  @Post(':id/cancel')
  public async cancel(@Param('id') id: string, @Res() res: FastifyReply): Promise<void> {
    await sendFilesResponse(
      res,
      async () => ({
        body: toOpenAIUploadObject(this.uploads.cancel(id), 'cancelled'),
      }),
      openAIUploadErrorResponse,
    );
  }
}
