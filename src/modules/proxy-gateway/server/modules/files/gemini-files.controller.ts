import {
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

import { ProxyGuard } from '../../guards/proxy.guard';
import { ProtocolErrors } from '../../common/protocol-errors.decorator';
import { FileStoreError } from './file-store.types';
import { FilesService } from './files.service';
import {
  geminiFileErrorResponse,
  readGeminiUploadDisplayName,
  toGeminiFileResource,
} from './gemini-file-resource';
import { normalizeUploadError, parseFileUploadRequest } from './file-upload-request';

/** Gemini route adapter for the shared local Files capability. */
@Controller()
@UseGuards(ProxyGuard)
export class GeminiFilesController {
  constructor(@Inject(FilesService) private readonly files: FilesService) {}

  @Post('upload/v1beta/files')
  @HttpCode(HttpStatus.OK)
  @ProtocolErrors((error) => geminiFileErrorResponse(normalizeUploadError(error)))
  async upload(@Req() request: FastifyRequest, @Query('uploadType') uploadType?: string) {
    if (uploadType && !['media', 'multipart'].includes(uploadType)) {
      throw new FileStoreError(
        'invalid_id',
        `uploadType=${uploadType} is not implemented; use media or multipart`,
        400,
      );
    }
    const upload = await parseFileUploadRequest(request);
    const record = await this.files.create({
      bytes: upload.bytes,
      declaredMimeType: upload.mimeType,
      displayName: readGeminiUploadDisplayName(upload.fields) ?? upload.filename,
    });
    return { file: toGeminiFileResource(record, resolveBaseUrl(request)) };
  }

  @Get('v1beta/files')
  @ProtocolErrors(geminiFileErrorResponse)
  async list(
    @Req() request: FastifyRequest,
    @Query('pageSize') pageSize?: string,
    @Query('pageToken') pageToken?: string,
  ) {
    const page = await this.files.list(pageSize, pageToken);
    const baseUrl = resolveBaseUrl(request);
    return {
      files: page.files.map((record) => toGeminiFileResource(record, baseUrl)),
      ...(page.nextPageToken ? { nextPageToken: page.nextPageToken } : {}),
    };
  }

  @Get('v1beta/files/:name')
  @ProtocolErrors(geminiFileErrorResponse)
  async get(@Param('name') name: string, @Req() request: FastifyRequest) {
    return toGeminiFileResource(await this.files.stat(name), resolveBaseUrl(request));
  }

  @Delete('v1beta/files/:name')
  @ProtocolErrors(geminiFileErrorResponse)
  async remove(@Param('name') name: string) {
    await this.files.remove(name);
    return {};
  }
}

/**
 * The `uri` a client echoes back as `fileData.fileUri`.
 *
 * It names this proxy rather than `generativelanguage.googleapis.com`, because
 * that is where the bytes actually are. Resolution accepts the bare id and the
 * `files/{id}` resource name too, so a client that stores only part of the URI
 * still works.
 */
function resolveBaseUrl(request: FastifyRequest): string {
  const host = request.headers.host ?? '127.0.0.1';
  const protocol = (request.headers['x-forwarded-proto'] as string | undefined) ?? 'http';
  return `${protocol}://${host}`;
}
