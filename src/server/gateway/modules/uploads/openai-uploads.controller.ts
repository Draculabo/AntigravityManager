import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

import { ProxyGuard } from '../../guards/proxy.guard';
import { ProtocolErrors } from '../../common/protocol-errors.decorator';
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
  @HttpCode(HttpStatus.OK)
  @ProtocolErrors(openAIUploadErrorResponse)
  public create(@Body() body: unknown) {
    return toOpenAIUploadObject(this.uploads.create(body));
  }

  @Post(':id/parts')
  @HttpCode(HttpStatus.OK)
  @ProtocolErrors((error) => openAIUploadErrorResponse(normalizeUploadError(error)))
  public async addPart(@Param('id') id: string, @Req() request: FastifyRequest) {
    const upload = await parseFileUploadRequest(request, { allowRawBody: false });
    const part = this.uploads.addPart(id, upload.bytes);
    return toOpenAIUploadPartObject(id, part);
  }

  @Post(':id/complete')
  @HttpCode(HttpStatus.OK)
  @ProtocolErrors(openAIUploadErrorResponse)
  public async complete(@Param('id') id: string, @Body() body: unknown) {
    return toOpenAIFileObject(await this.uploads.complete(id, body));
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @ProtocolErrors(openAIUploadErrorResponse)
  public cancel(@Param('id') id: string) {
    return toOpenAIUploadObject(this.uploads.cancel(id), 'cancelled');
  }
}
