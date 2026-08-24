import {
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { ProxyGuard } from '../../guards/proxy.guard';
import { FileStoreError } from './file-store.types';
import { FilesService, sendFilesResponse } from './files.service';
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
  async upload(
    @Req() request: FastifyRequest,
    @Res() res: FastifyReply,
    @Query('uploadType') uploadType?: string,
  ): Promise<void> {
    await sendFilesResponse(
      res,
      async () => {
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
        return { body: { file: toGeminiFileResource(record, resolveBaseUrl(request)) } };
      },
      geminiFileErrorResponse,
      normalizeUploadError,
    );
  }

  @Get('v1beta/files')
  async list(
    @Req() request: FastifyRequest,
    @Res() res: FastifyReply,
    @Query('pageSize') pageSize?: string,
    @Query('pageToken') pageToken?: string,
  ): Promise<void> {
    await sendFilesResponse(
      res,
      async () => {
        const page = await this.files.list(pageSize, pageToken);
        const baseUrl = resolveBaseUrl(request);
        return {
          body: {
            files: page.files.map((record) => toGeminiFileResource(record, baseUrl)),
            ...(page.nextPageToken ? { nextPageToken: page.nextPageToken } : {}),
          },
        };
      },
      geminiFileErrorResponse,
    );
  }

  @Get('v1beta/files/:name')
  async get(
    @Param('name') name: string,
    @Req() request: FastifyRequest,
    @Res() res: FastifyReply,
  ): Promise<void> {
    await sendFilesResponse(
      res,
      async () => ({
        body: toGeminiFileResource(await this.files.stat(name), resolveBaseUrl(request)),
      }),
      geminiFileErrorResponse,
    );
  }

  @Delete('v1beta/files/:name')
  async remove(@Param('name') name: string, @Res() res: FastifyReply): Promise<void> {
    await sendFilesResponse(
      res,
      async () => {
        await this.files.remove(name);
        return { body: {} };
      },
      geminiFileErrorResponse,
    );
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
