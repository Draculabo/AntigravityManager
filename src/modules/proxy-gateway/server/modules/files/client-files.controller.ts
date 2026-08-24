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
import {
  anthropicFileErrorResponse,
  requireAnthropicFilesBeta,
  toAnthropicFileObject,
} from './anthropic-file-resource';
import { parseFileHandle, type StoredFileRecord } from './file-store.types';
import { FilesService, sendFilesResponse, type FilesErrorResponse } from './files.service';
import {
  normalizeOpenAIPurpose,
  openAIFileErrorResponse,
  toOpenAIFileObject,
} from './openai-file-resource';
import { normalizeUploadError, parseFileUploadRequest } from './file-upload-request';

type FilesDialect = 'anthropic' | 'openai';

/** OpenAI and Anthropic route adapter for the shared local Files capability. */
@Controller('v1/files')
@UseGuards(ProxyGuard)
export class ClientFilesController {
  constructor(@Inject(FilesService) private readonly files: FilesService) {}

  @Post()
  async upload(@Req() request: FastifyRequest, @Res() res: FastifyReply): Promise<void> {
    const dialect = resolveDialect(request);
    await sendFilesResponse(
      res,
      async () => {
        this.enforceDialectGate(dialect, request);
        const upload = await parseFileUploadRequest(request, { allowRawBody: false });
        const purpose =
          dialect === 'openai' ? normalizeOpenAIPurpose(upload.fields.purpose) : undefined;
        const record = await this.files.create({
          bytes: upload.bytes,
          declaredMimeType: upload.mimeType,
          displayName: upload.filename,
          purpose,
        });
        return { body: this.toResource(dialect, record) };
      },
      (error) => this.toErrorResponse(dialect, error),
      normalizeUploadError,
    );
  }

  @Get()
  async list(
    @Req() request: FastifyRequest,
    @Res() res: FastifyReply,
    @Query('limit') limit?: string,
    @Query('after') after?: string,
  ): Promise<void> {
    const dialect = resolveDialect(request);
    await sendFilesResponse(
      res,
      async () => {
        this.enforceDialectGate(dialect, request);
        const page = await this.files.list(
          limit,
          after ? (parseFileHandle(after) ?? after) : undefined,
        );
        const data = page.files.map((record) => this.toResource(dialect, record));
        return {
          body:
            dialect === 'openai'
              ? { object: 'list' as const, data, has_more: page.hasMore }
              : {
                  data,
                  has_more: page.hasMore,
                  first_id: data.at(0)?.id ?? null,
                  last_id: data.at(-1)?.id ?? null,
                },
        };
      },
      (error) => this.toErrorResponse(dialect, error),
    );
  }

  @Get(':id')
  async get(
    @Param('id') id: string,
    @Req() request: FastifyRequest,
    @Res() res: FastifyReply,
  ): Promise<void> {
    const dialect = resolveDialect(request);
    await sendFilesResponse(
      res,
      async () => {
        this.enforceDialectGate(dialect, request);
        return { body: this.toResource(dialect, await this.files.stat(id)) };
      },
      (error) => this.toErrorResponse(dialect, error),
    );
  }

  @Get(':id/content')
  async content(
    @Param('id') id: string,
    @Req() request: FastifyRequest,
    @Res() res: FastifyReply,
  ): Promise<void> {
    const dialect = resolveDialect(request);
    await sendFilesResponse(
      res,
      async () => {
        this.enforceDialectGate(dialect, request);
        const { record, bytes } = await this.files.content(id);
        return {
          body: bytes,
          headers: {
            'Content-Type': record.mimeType,
            'Content-Length': String(record.sizeBytes),
          },
        };
      },
      (error) => this.toErrorResponse(dialect, error),
    );
  }

  @Delete(':id')
  async remove(
    @Param('id') id: string,
    @Req() request: FastifyRequest,
    @Res() res: FastifyReply,
  ): Promise<void> {
    const dialect = resolveDialect(request);
    await sendFilesResponse(
      res,
      async () => {
        this.enforceDialectGate(dialect, request);
        const handle = await this.files.remove(id);
        return {
          body:
            dialect === 'openai'
              ? { id: `file-${handle}`, object: 'file' as const, deleted: true }
              : { id: `file_${handle}`, type: 'file_deleted' as const },
        };
      },
      (error) => this.toErrorResponse(dialect, error),
    );
  }

  private enforceDialectGate(dialect: FilesDialect, request: FastifyRequest): void {
    if (dialect === 'anthropic') {
      requireAnthropicFilesBeta(readHeader(request, 'anthropic-beta'));
    }
  }

  private toResource(dialect: FilesDialect, record: StoredFileRecord): { id: string } {
    return dialect === 'openai' ? toOpenAIFileObject(record) : toAnthropicFileObject(record);
  }

  private toErrorResponse(dialect: FilesDialect, error: unknown): FilesErrorResponse {
    return dialect === 'openai'
      ? openAIFileErrorResponse(error)
      : anthropicFileErrorResponse(error);
  }
}

function readHeader(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value.join(',') : value;
}

function resolveDialect(request: FastifyRequest): FilesDialect {
  return readHeader(request, 'anthropic-version') || readHeader(request, 'anthropic-beta')
    ? 'anthropic'
    : 'openai';
}
