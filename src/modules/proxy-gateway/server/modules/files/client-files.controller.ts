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
import { FileStoreError, parseFileHandle, type StoredFileRecord } from './file-store.types';
import {
  anthropicFileErrorResponse,
  requireAnthropicFilesBeta,
  toAnthropicFileObject,
} from './anthropic-file-resource';
import {
  normalizeOpenAIPurpose,
  openAIFileErrorResponse,
  toOpenAIFileObject,
} from './openai-file-resource';
import { normalizeUploadError, parseFileUploadRequest } from './file-upload-request';

type FilesDialect = 'anthropic' | 'openai';

/**
 * OpenAI and Anthropic both publish their Files API at exactly `/v1/files`, so
 * one route table has to serve both. The dialect is chosen per request from the
 * headers — any `anthropic-version` or `anthropic-beta` header means the
 * Anthropic dialect, everything else is OpenAI — and each dialect's resource
 * shapes, error envelopes and upload rules live in its own adapter module
 * beside this one.
 *
 * Both dialects are views over the same content-addressed store, so a file
 * uploaded through one surface can be referenced from any of the three. Its id
 * is spelled `file-…`, `file_…` or `files/…` depending on who is asking.
 */
@Controller('v1/files')
@UseGuards(ProxyGuard)
export class ClientFilesController {
  constructor(@Inject(FileContentStore) private readonly store: FileContentStore) {}

  @Post()
  async upload(@Req() request: FastifyRequest, @Res() res: FastifyReply): Promise<void> {
    const dialect = resolveDialect(request);
    try {
      this.enforceDialectGate(dialect, request);
      const upload = await parseFileUploadRequest(request, { allowRawBody: false });
      const purpose =
        dialect === 'openai' ? normalizeOpenAIPurpose(upload.fields.purpose) : undefined;
      const record = await this.store.put({
        bytes: upload.bytes,
        declaredMimeType: upload.mimeType,
        displayName: upload.filename,
        purpose,
      });
      res.status(HttpStatus.OK).send(this.toResource(dialect, record));
    } catch (error) {
      this.sendError(dialect, res, normalizeUploadError(error));
    }
  }

  @Get()
  async list(
    @Req() request: FastifyRequest,
    @Res() res: FastifyReply,
    @Query('limit') limit?: string,
    @Query('after') after?: string,
  ): Promise<void> {
    const dialect = resolveDialect(request);
    try {
      this.enforceDialectGate(dialect, request);
      const result = await this.store.list({
        limit: limit ? Number(limit) : undefined,
        pageToken: after ? (parseFileHandle(after) ?? after) : undefined,
      });
      const data = result.files.map((record) => this.toResource(dialect, record));
      res.status(HttpStatus.OK).send(
        dialect === 'openai'
          ? { object: 'list', data, has_more: Boolean(result.nextPageToken) }
          : {
              data,
              has_more: Boolean(result.nextPageToken),
              first_id: data.at(0)?.id ?? null,
              last_id: data.at(-1)?.id ?? null,
            },
      );
    } catch (error) {
      this.sendError(dialect, res, error);
    }
  }

  @Get(':id')
  async get(
    @Param('id') id: string,
    @Req() request: FastifyRequest,
    @Res() res: FastifyReply,
  ): Promise<void> {
    const dialect = resolveDialect(request);
    try {
      this.enforceDialectGate(dialect, request);
      const record = await this.store.stat(requireHandle(id));
      res.status(HttpStatus.OK).send(this.toResource(dialect, record));
    } catch (error) {
      this.sendError(dialect, res, error);
    }
  }

  @Get(':id/content')
  async content(
    @Param('id') id: string,
    @Req() request: FastifyRequest,
    @Res() res: FastifyReply,
  ): Promise<void> {
    const dialect = resolveDialect(request);
    try {
      this.enforceDialectGate(dialect, request);
      const { record, bytes } = await this.store.get(requireHandle(id));
      res
        .header('Content-Type', record.mimeType)
        .header('Content-Length', String(record.sizeBytes))
        .status(HttpStatus.OK)
        .send(bytes);
    } catch (error) {
      this.sendError(dialect, res, error);
    }
  }

  @Delete(':id')
  async remove(
    @Param('id') id: string,
    @Req() request: FastifyRequest,
    @Res() res: FastifyReply,
  ): Promise<void> {
    const dialect = resolveDialect(request);
    try {
      this.enforceDialectGate(dialect, request);
      const handle = requireHandle(id);
      if (!(await this.store.delete(handle))) {
        throw FileStoreError.notFound(id);
      }
      res
        .status(HttpStatus.OK)
        .send(
          dialect === 'openai'
            ? { id: `file-${handle}`, object: 'file', deleted: true }
            : { id: `file_${handle}`, type: 'file_deleted' },
        );
    } catch (error) {
      this.sendError(dialect, res, error);
    }
  }

  private enforceDialectGate(dialect: FilesDialect, request: FastifyRequest): void {
    if (dialect === 'anthropic') {
      requireAnthropicFilesBeta(readHeader(request, 'anthropic-beta'));
    }
  }

  private toResource(dialect: FilesDialect, record: StoredFileRecord): { id: string } {
    return dialect === 'openai' ? toOpenAIFileObject(record) : toAnthropicFileObject(record);
  }

  private sendError(dialect: FilesDialect, res: FastifyReply, error: unknown): void {
    const { statusCode, body } =
      dialect === 'openai' ? openAIFileErrorResponse(error) : anthropicFileErrorResponse(error);
    res.status(statusCode).send(body);
  }
}

function requireHandle(id: string): string {
  const handle = parseFileHandle(id);
  if (!handle) {
    throw FileStoreError.notFound(id);
  }
  return handle;
}

function readHeader(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value.join(',') : value;
}

/**
 * Anthropic clients always announce themselves with `anthropic-version` (their
 * SDKs send it on every call) or with `anthropic-beta`. Nothing on the OpenAI
 * side sends either header, so this is a signal rather than a guess.
 */
function resolveDialect(request: FastifyRequest): FilesDialect {
  return readHeader(request, 'anthropic-version') || readHeader(request, 'anthropic-beta')
    ? 'anthropic'
    : 'openai';
}
