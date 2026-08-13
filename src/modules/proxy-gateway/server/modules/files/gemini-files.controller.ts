import {
  Controller,
  Delete,
  Get,
  HttpStatus,
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
import { FileContentStore } from './file-content-store.service';
import { FileStoreError, parseFileHandle } from './file-store.types';
import {
  geminiFileErrorResponse,
  readGeminiUploadDisplayName,
  toGeminiFileResource,
} from './gemini-file-resource';
import { normalizeUploadError, parseFileUploadRequest } from './file-upload-request';

/**
 * Gemini `files` surface: `POST /upload/v1beta/files`, plus list, get and
 * delete under `/v1beta/files`.
 *
 * This is a local store, not a provider file plane. Uploads are held on this
 * machine and expanded back into `inlineData` when a later request names them;
 * nothing is stored on Google's side and no upstream token cost changes. The
 * routes exist so Gemini clients can use their normal upload-then-reference
 * flow against this proxy.
 *
 * Resumable uploads are not implemented; both the simple media form and the
 * multipart form are.
 */
@Controller()
@UseGuards(ProxyGuard)
export class GeminiFilesController {
  constructor(@Inject(FileContentStore) private readonly store: FileContentStore) {}

  @Post('upload/v1beta/files')
  async upload(
    @Req() request: FastifyRequest,
    @Res() res: FastifyReply,
    @Query('uploadType') uploadType?: string,
  ): Promise<void> {
    try {
      if (uploadType && !['media', 'multipart'].includes(uploadType)) {
        throw new FileStoreError(
          'invalid_id',
          `uploadType=${uploadType} is not implemented; use media or multipart`,
          400,
        );
      }
      const upload = await parseFileUploadRequest(request);
      const record = await this.store.put({
        bytes: upload.bytes,
        declaredMimeType: upload.mimeType,
        displayName: readGeminiUploadDisplayName(upload.fields) ?? upload.filename,
      });
      res
        .status(HttpStatus.OK)
        .send({ file: toGeminiFileResource(record, resolveBaseUrl(request)) });
    } catch (error) {
      this.sendError(res, normalizeUploadError(error));
    }
  }

  @Get('v1beta/files')
  async list(
    @Req() request: FastifyRequest,
    @Res() res: FastifyReply,
    @Query('pageSize') pageSize?: string,
    @Query('pageToken') pageToken?: string,
  ): Promise<void> {
    try {
      const result = await this.store.list({
        limit: pageSize ? Number(pageSize) : undefined,
        pageToken,
      });
      const baseUrl = resolveBaseUrl(request);
      res.status(HttpStatus.OK).send({
        files: result.files.map((record) => toGeminiFileResource(record, baseUrl)),
        ...(result.nextPageToken ? { nextPageToken: result.nextPageToken } : {}),
      });
    } catch (error) {
      this.sendError(res, error);
    }
  }

  @Get('v1beta/files/:name')
  async get(
    @Param('name') name: string,
    @Req() request: FastifyRequest,
    @Res() res: FastifyReply,
  ): Promise<void> {
    try {
      const record = await this.store.stat(requireHandle(name));
      res.status(HttpStatus.OK).send(toGeminiFileResource(record, resolveBaseUrl(request)));
    } catch (error) {
      this.sendError(res, error);
    }
  }

  @Delete('v1beta/files/:name')
  async remove(@Param('name') name: string, @Res() res: FastifyReply): Promise<void> {
    try {
      const id = requireHandle(name);
      if (!(await this.store.delete(id))) {
        throw FileStoreError.notFound(name);
      }
      res.status(HttpStatus.OK).send({});
    } catch (error) {
      this.sendError(res, error);
    }
  }

  private sendError(res: FastifyReply, error: unknown): void {
    const { statusCode, body } = geminiFileErrorResponse(error);
    res.status(statusCode).send(body);
  }
}

function requireHandle(name: string): string {
  const id = parseFileHandle(name);
  if (!id) {
    throw FileStoreError.notFound(name);
  }
  return id;
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
